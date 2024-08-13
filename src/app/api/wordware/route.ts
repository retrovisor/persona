import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

export const maxDuration = 300

const logger = {
  info: (message: string, data?: any) => console.log(`INFO: ${message}`, data ? JSON.stringify(data) : ''),
  warn: (message: string, data?: any) => console.warn(`WARN: ${message}`, data ? JSON.stringify(data) : ''),
  error: (message: string, error: any) => console.error(`ERROR: ${message}`, error),
};

const FUNCTION_TIMEOUT = 25000; // 25 seconds

export async function POST(request: Request) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Function timed out')), FUNCTION_TIMEOUT)
  );

  try {
    const result = await Promise.race([
      handleRequest(request),
      timeoutPromise
    ]);

    logger.info('🟢 Function completed successfully');
    return result;
  } catch (error) {
    if (error.message === 'Function timed out') {
      logger.error('⏰ Function execution timed out');
      return new Response(JSON.stringify({ error: 'Operation timed out' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    logger.error('❌ Unexpected error:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleRequest(request: Request) {
  const { username, full } = await request.json()
  logger.info(`Processing request for username: ${username}, full: ${full}`)

  const user = await getUser({ username })

  if (!user) {
    logger.error(`User not found: ${username}`)
    return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 })
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    logger.warn(`Wordware already started or completed for ${username}`)
    return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    logger.warn(`Paid Wordware already started or completed for ${username}`)
    return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
  }

  const tweets = user.tweets as TweetType[]
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  logger.info(`Prepared ${tweets.length} tweets for analysis`)

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  logger.info(`Using promptID: ${promptID}`)

  logger.info('Sending request to Wordware API')
  const runResponse = await fetch(`https://app.wordware.ai/api/released-app/${promptID}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {
        tweets: `Tweets: ${tweetsMarkdown}`,
        version: '^1.3',
      },
    }),
  })

  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    logger.error('Wordware API Error:', runResponse.status, await runResponse.text())
    return new Response(JSON.stringify({ error: 'Wordware API Error' }), { status: 500 })
  }

  logger.info('Received successful response from Wordware API')

  logger.info('Updating user to indicate Wordware has started')
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  const stream = createReadableStream(reader, user, full)

  logger.info('Returning stream response')
  return new Response(stream, {
    headers: { 
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    },
  })
}

function formatTweet(tweet: TweetType) {
  const isRetweet = tweet.isRetweet ? 'RT ' : ''
  const author = tweet.author?.userName ?? ''
  const createdAt = tweet.createdAt
  const text = tweet.text ?? ''
  const formattedText = text
    .split('\n')
    .map((line) => `${line}`)
    .join(`\n> `)
  return `**${isRetweet}@${author} - ${createdAt}**

> ${formattedText}

*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`
}

function createReadableStream(reader: ReadableStreamDefaultReader<Uint8Array>, user: any, full: boolean) {
  const decoder = new TextDecoder()
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let generationEventCount = 0
  const FORCE_FINAL_OUTPUT_AFTER = 50

  const timeoutDuration = 5 * 60 * 1000
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutDuration)

  return new ReadableStream({
    async start(controller) {
      let finalAnalysis = null;
      let buffer: string[] = [];
      let finalOutput = false;
      try {
        while (true) {
          if (abortController.signal.aborted) {
            throw new Error('Stream processing timed out');
          }

          const { done, value } = await reader.read()

          if (done) {
            logger.info('Stream reading completed');
            break;
          }

          const chunk = decoder.decode(value)
          chunkCount++

          if (chunkCount % 10 === 0) {
            logger.info(`Processed ${chunkCount} chunks. Last chunk at ${new Date().toISOString()}`);
            logMemoryUsage();
          }

          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            try {
              const content = JSON.parse(line)
              const value = content.value

              if (value.type === 'generation') {
                generationEventCount++
                if (value.state === 'start') {
                  if (value.label === 'output') {
                    finalOutput = true
                  }
                } else {
                  if (value.label === 'output') {
                    finalOutput = false
                  }
                }
              } else if (value.type === 'chunk') {
                if (finalOutput) {
                  controller.enqueue(value.value ?? '')
                }
              } else if (value.type === 'outputs') {
                logger.info(`Wordware ${full ? 'Full' : 'Roast'}:`, value.values.output, 'Now parsing')
                finalAnalysis = value.values.output;
                break;
              }

              buffer = []
            } catch (error) {
              logger.error('Error processing line:', error, 'Line content:', line)
              buffer = []
            }
          }

          if (!finalOutput && chunkCount >= FORCE_FINAL_OUTPUT_AFTER) {
            logger.warn(`Forcing finalOutput to true after ${FORCE_FINAL_OUTPUT_AFTER} chunks`);
            finalOutput = true;
          }

          if (finalAnalysis) break;
        }
      } catch (error) {
        logger.error('Critical error in stream processing:', error);
        if (error.name === 'AbortError') {
          logger.error('Stream processing timed out after', timeoutDuration / 1000, 'seconds');
        }
      } finally {
        clearTimeout(timeoutId);
        reader.releaseLock()
        
        if (finalAnalysis) {
          await saveAnalysisAndUpdateUser(user, { values: { output: finalAnalysis } }, full);
        } else {
          logger.error(`No final analysis received for ${full ? 'Full' : 'Roast'} version`);
          if (buffer.length > 0) {
            logger.info('Attempting to save last processed chunk');
            await saveAnalysisAndUpdateUser(user, { values: { output: buffer.join('') } }, full);
          }
        }

        logger.info(`Stream processing finished`);
        logger.info(`Total chunks processed: ${chunkCount}`);
        logger.info(`Total generation events: ${generationEventCount}`);
        controller.close();
      }
    },
  })
}

function logMemoryUsage() {
  const used = process.memoryUsage()
  logger.info('Memory usage:')
  for (const key in used) {
    logger.info(`${key}: ${Math.round(used[key as keyof NodeJS.MemoryUsage] / 1024 / 1024 * 100) / 100} MB`)
  }
}

async function saveAnalysisAndUpdateUser(user: any, value: any, full: boolean) {
  if (!value || !value.values || !value.values.output) {
    logger.error('Attempted to save empty or invalid analysis');
    return;
  }

  logger.info(`Attempting to save analysis. Value received:`, JSON.stringify(value));
  
  const statusObject = full
    ? {
        paidWordwareStarted: true,
        paidWordwareCompleted: true,
      }
    : { wordwareStarted: true, wordwareCompleted: true };

  try {
    await updateUser({
      user: {
        ...user,
        ...statusObject,
        analysis: {
          ...user?.analysis,
          ...value.values.output,
        },
      },
    });
    logger.info('Analysis saved to database');
  } catch (error) {
    logger.error('Error parsing or saving output:', error);
    const statusObject = full
      ? {
          paidWordwareStarted: false,
          paidWordwareCompleted: false,
        }
      : { wordwareStarted: false, wordwareCompleted: false };
    await updateUser({
      user: {
        ...user,
        ...statusObject,
      },
    });
    logger.warn('Updated user status to indicate failure');
  }
}
