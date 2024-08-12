import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

/**
 * Maximum duration for the API route execution (in seconds)
 */
export const maxDuration = 300

/**
 * POST handler for the Wordware API route
 * @param {Request} request - The incoming request object
 * @returns {Promise<Response>} The response object
 */
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
        profilePicture: user.profilePicture,
        profileInfo: user.fullProfile,
        version: '^1.0',
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
      [full ? 'paidWordwareStarted' : 'wordwareStarted']: true,
      [full ? 'paidWordwareStartedTime' : 'wordwareStartedTime']: new Date(),
    },
  })

  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  let chunkCount = 0
  let lastChunkTime = Date.now()
  let generationEventCount = 0
  const FORCE_FINAL_OUTPUT_AFTER = 50 // Force finalOutput after this many chunks if not set

  function logMemoryUsage() {
    const used = process.memoryUsage()
    console.log('🧠 Memory usage:')
    for (const key in used) {
      console.log(`${key}: ${Math.round(used[key as keyof NodeJS.MemoryUsage] / 1024 / 1024 * 100) / 100} MB`)
    }
  }

  async function saveAnalysisAndUpdateUser(user, value, full) {
    console.log(`🟢 Attempting to save analysis. Full: ${full}, Value received:`, JSON.stringify(value));
    
    const statusObject = full
      ? {
          paidWordwareStarted: true,
          paidWordwareCompleted: true,
        }
      : { wordwareStarted: true, wordwareCompleted: true };

    try {
      let analysisToSave;
      if (full) {
        // For full analysis, overwrite the entire analysis
        analysisToSave = value.values.output;
      } else {
        // For free analysis, only update specific fields
        analysisToSave = {
          ...user.analysis, // Keep existing analysis
          roast: value.values.output.roast,
          emojis: value.values.output.emojis,
          // Add any other fields that should be updated for free analysis
        };
      }

      await updateUser({
        user: {
          ...user,
          ...statusObject,
          analysis: analysisToSave,
        },
      });
      console.log(`🟢 Analysis saved to database. Full: ${full}`);
    } catch (error) {
      console.error('❌ Error parsing or saving output:', error);
      const failureStatusObject = full
        ? {
            paidWordwareStarted: false,
            paidWordwareCompleted: false,
          }
        : { wordwareStarted: false, wordwareCompleted: false };
      await updateUser({
        user: {
          ...user,
          ...failureStatusObject,
        },
      });
      console.log(`🟠 Updated user status to indicate failure. Full: ${full}`);
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started');
      let lastProcessedValue = null;
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            console.log('🟢 Stream reading completed');
            if (lastProcessedValue) {
              console.log('🔄 Attempting to save analysis at the end of stream.');
              await saveAnalysisAndUpdateUser(user, lastProcessedValue, full);
            }
            controller.close();
            return;
          }

          const chunk = decoder.decode(value);
          chunkCount++;
          const now = Date.now();
          console.log(`🟣 Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastChunkTime}ms since last chunk`);
          lastChunkTime = now;

          if (chunkCount <= 5) {
            console.log(`🔍 Full chunk content: ${chunk}`);
          }

          if (chunkCount % 10 === 0) {
            console.log(`🟠 Buffer size: ${buffer.join('').length} characters`);
            logMemoryUsage();
          }

          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n';

            if (!isChunkSeparator) {
              buffer.push(chunk[i]);
              continue;
            }

            const line = buffer.join('').trimEnd();

            try {
              const content = JSON.parse(line);
              const value = content.value;

              if (value.type === 'generation') {
                console.log(`🔵 Generation event: ${value.state} - ${value.label}`);
                generationEventCount++;
                if (value.state === 'start') {
                  if (value.label === 'output') {
                    finalOutput = true;
                    console.log('🔵 finalOutput set to true');
                  }
                } else {
                  if (value.label === 'output') {
                    finalOutput = false;
                    console.log('🔵 finalOutput set to false');
                  }
                }
              } else if (value.type === 'chunk') {
                controller.enqueue(value.value ?? '');
                console.log(`🟢 Enqueued chunk: ${(value.value ?? '').slice(0, 50)}...`);
              } else if (value.type === 'outputs') {
                console.log('✨ Received final output from Wordware. Now parsing');
                lastProcessedValue = value;
                await saveAnalysisAndUpdateUser(user, value, full);
              }

              if (!finalOutput && chunkCount >= FORCE_FINAL_OUTPUT_AFTER) {
                console.log(`🔴 Forcing finalOutput to true after ${FORCE_FINAL_OUTPUT_AFTER} chunks`);
                finalOutput = true;
              }
            } catch (error) {
              console.error('❌ Error processing line:', error, 'Line content:', line);
            }

            buffer = [];
          }
        }
      } catch (error) {
        console.error('❌ Critical error in stream processing:', error);
      } finally {
        console.log('🟢 Stream processing finished');
        console.log(`🟢 Total chunks processed: ${chunkCount}`);
        console.log(`🟢 Total generation events: ${generationEventCount}`);
        if (lastProcessedValue) {
          // Attempt to save analysis if it wasn't saved during the process
          console.log('🔄 Attempting final save of analysis.');
          await saveAnalysisAndUpdateUser(user, lastProcessedValue, full);
        }
        reader.releaseLock();
      }
    },
  });

  console.log('🟢 Returning stream response')
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
