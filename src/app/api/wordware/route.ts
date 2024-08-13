import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

export const maxDuration = 300

export async function POST(request: Request) {
  const { username, full } = await request.json()
  console.log(`🟢 Processing request for username: ${username}, full: ${full}`)

  const user = await getUser({ username })

  if (!user) {
    console.log(`❌ User not found: ${username}`)
    throw Error(`User not found: ${username}`)
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Wordware already started or completed for ${username}`)
      return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Paid Wordware already started or completed for ${username}`)
      return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
    }
  }

  function formatTweet(tweet: TweetType) {
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
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

  const tweets = user.tweets as TweetType[]
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log(`🟢 Prepared ${tweets.length} tweets for analysis`)

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`🟢 Using promptID: ${promptID}`)

  console.log('🟢 Sending request to Wordware API')
  const runResponse = await fetch(`https://app.wordware.ai/api/released-app/${promptID}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {
        tweets: `Tweets: ${tweetsMarkdown}`,
         version: '^3.2',
      },
    }),
  })

  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    console.log('🟣 | ERROR | Wordware API Error:', runResponse.status, await runResponse.text())
    return new Response(JSON.stringify({ error: 'No reader' }), { status: 400 })
  }

  console.log('🟢 Received successful response from Wordware API')

  console.log('🟢 Updating user to indicate Wordware has started')
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  const decoder = new TextDecoder()
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let generationEventCount = 0
  const FORCE_FINAL_OUTPUT_AFTER = 50

  function logMemoryUsage() {
    const used = process.memoryUsage()
    console.log('🧠 Memory usage:')
    for (const key in used) {
      console.log(`${key}: ${Math.round(used[key as keyof NodeJS.MemoryUsage] / 1024 / 1024 * 100) / 100} MB`)
    }
  }

  const timeoutDuration = 5 * 60 * 1000
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutDuration)

  async function saveAnalysisAndUpdateUser(user, value, full) {
    if (!value || !value.values || !value.values.output) {
      console.error('❌ Attempted to save empty or invalid analysis');
      return;
    }

    console.log(`🟢 Attempting to save analysis. Value received:`, JSON.stringify(value));
    
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
            ...existingAnalysis,
            ...value.values.output,
          },
        },
      });
      console.log('🟢 Analysis saved to database');
    } catch (error) {
      console.error('❌ Error parsing or saving output:', error);
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
      console.log('🟠 Updated user status to indicate failure');
    }
  }

  const stream = new ReadableStream({
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
            console.log('Stream reading completed');
            break;
          }

          const chunk = decoder.decode(value)
          chunkCount++

          if (chunkCount % 10 === 0) {
            console.log(`🟠 Processed ${chunkCount} chunks. Last chunk at ${new Date().toISOString()}`);
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
                console.log(`✨ Wordware ${full ? 'Full' : 'Roast'}:`, value.values.output, '. Now parsing')
                finalAnalysis = value.values.output;
                break;
              }

              buffer = []
            } catch (error) {
              console.error('Error processing line:', error, 'Line content:', line)
              buffer = []
            }
          }

          if (!finalOutput && chunkCount >= FORCE_FINAL_OUTPUT_AFTER) {
            console.log(`🔴 Forcing finalOutput to true after ${FORCE_FINAL_OUTPUT_AFTER} chunks`);
            finalOutput = true;
          }

          if (finalAnalysis) break;
        }
      } catch (error) {
        console.error('Critical error in stream processing:', error);
        if (error.name === 'AbortError') {
          console.error('Stream processing timed out after', timeoutDuration / 1000, 'seconds');
        }
      } finally {
        clearTimeout(timeoutId);
        reader.releaseLock()
        
        if (finalAnalysis) {
          await saveAnalysisAndUpdateUser(user, { values: { output: finalAnalysis } }, full);
        } else {
          console.error(`No final analysis received for ${full ? 'Full' : 'Roast'} version`);
          if (buffer.length > 0) {
            console.log('Attempting to save last processed chunk');
            await saveAnalysisAndUpdateUser(user, { values: { output: buffer.join('') } }, full);
          }
        }

        console.log(`🟢 Stream processing finished`);
        console.log(`🟢 Total chunks processed: ${chunkCount}`);
        console.log(`🟢 Total generation events: ${generationEventCount}`);
      }
    },
  })

  console.log('🟢 Returning stream response')
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
