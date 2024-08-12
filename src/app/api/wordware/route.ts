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
  // Extract username from the request body
  const { username, full } = await request.json()
  console.log(`🟢 Processing request for username: ${username}, full: ${full}`)

  // Fetch user data and check if Wordware has already been started
  const user = await getUser({ username })

  if (!user) {
    console.log(`❌ User not found: ${username}`)
    throw Error(`User not found: ${username}`)
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Wordware already started or completed for ${username}`)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Paid Wordware already started or completed for ${username}`)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  function formatTweet(tweet: TweetType) {
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
    const createdAt = tweet.createdAt
    const text = tweet.text ?? '' // Ensure text is not undefined
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

  // Make a request to the Wordware API
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

  // Get the reader from the response body
  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    console.log('🟣 | ERROR | Wordware API Error:', runResponse.status, await runResponse.text())
    return Response.json({ error: 'No reader' }, { status: 400 })
  }

  console.log('🟢 Received successful response from Wordware API')

  // Update user to indicate Wordware has started
  console.log('🟢 Updating user to indicate Wordware has started')
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  // Set up decoder and buffer for processing the stream
  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let lastHeartbeat = Date.now()
  let partialResult = ''

  // New function to log memory usage
  function logMemoryUsage() {
    const used = process.memoryUsage()
    console.log('🧠 Memory usage:')
    for (let key in used) {
      console.log(`${key}: ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`)
    }
  }

  // New function to save partial results
  async function savePartialResult(userId: string, result: string) {
    console.log(`💾 Saved partial result for user ${userId}. Length: ${result.length}`)
    // Implement actual saving logic here if needed
  }

  // Create a readable stream to process the response
  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started')
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            console.log('🟢 Stream reading completed')
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          chunkCount++
          const now = Date.now()
          console.log(`🟣 Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastHeartbeat}ms since last chunk`)
          lastHeartbeat = now

          if (chunkCount % 10 === 0) {
            console.log(`🟠 Buffer size: ${buffer.join('').length} characters`)
            console.log(`🟠 Partial result size: ${partialResult.length} characters`)
            logMemoryUsage()
          }

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            // Parse the JSON content of each line
            try {
              const content = JSON.parse(line)
              const value = content.value

              // Handle different types of messages in the stream
              if (value.type === 'generation') {
                console.log(`🔵 Generation event: ${value.state} - ${value.label}`)
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
                  partialResult += value.value ?? ''
                  controller.enqueue(value.value ?? '')
                  console.log(`🟢 Enqueued chunk: ${(value.value ?? '').slice(0, 50)}...`)
                }
              } else if (value.type === 'outputs') {
                console.log('✨ Received final output from Wordware. Now parsing')
                try {
                  const statusObject = full
                    ? {
                        paidWordwareStarted: true,
                        paidWordwareCompleted: true,
                      }
                    : { wordwareStarted: true, wordwareCompleted: true }
                  // Update user with the analysis from Wordware
                  await updateUser({
                    user: {
                      ...user,
                      ...statusObject,
                      analysis: {
                        ...existingAnalysis,
                        ...value.values.output,
                      },
                    },
                  })
                  console.log('🟢 Analysis saved to database')
                } catch (error) {
                  console.error('❌ Error parsing or saving output:', error)

                  const statusObject = full
                    ? {
                        paidWordwareStarted: false,
                        paidWordwareCompleted: false,
                      }
                    : { wordwareStarted: false, wordwareCompleted: false }
                  await updateUser({
                    user: {
                      ...user,
                      ...statusObject,
                    },
                  })
                  console.log('🟠 Updated user status to indicate failure')
                }
              }

              // Save partial results every 1000 characters
              if (partialResult.length % 1000 < (partialResult.length - (value.value?.length ?? 0)) % 1000) {
                await savePartialResult(user.id, partialResult)
              }
            } catch (error) {
              console.error('❌ Error processing line:', error)
            }

            // Reset buffer for the next line
            buffer = []
          }

          // Heartbeat every 5 seconds if no chunk received
          if (now - lastHeartbeat > 5000) {
            console.log(`❤️ Heartbeat: ${now - lastHeartbeat}ms since last chunk`)
            lastHeartbeat = now
          }
        }
      } catch (error) {
        console.error('❌ Error in stream processing:', error)
      } finally {
        console.log('🟢 Stream processing finished')
        console.log(`🟢 Total chunks processed: ${chunkCount}`)
        console.log(`🟢 Final partial result size: ${partialResult.length} characters`)
        reader.releaseLock()
      }
    },
  })

  // Return the stream as the response
  console.log('🟢 Returning stream response')
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
