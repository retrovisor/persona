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
    return Response.json({ error: 'No reader' }, { status: 400 })
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
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let lastChunkTime = Date.now()

  function logMemoryUsage() {
    const used = process.memoryUsage()
    console.log('🧠 Memory usage:')
    for (const key in used) {
      console.log(`${key}: ${Math.round(used[key as keyof NodeJS.MemoryUsage] / 1024 / 1024 * 100) / 100} MB`)
    }
  }

  // Implement timeout mechanism
  const timeoutDuration = 5 * 60 * 1000 // 5 minutes
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutDuration)

  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started')
      try {
        while (true) {
          if (abortController.signal.aborted) {
            throw new Error('Stream processing timed out')
          }

          const { done, value } = await reader.read()

          if (done) {
            console.log('🟢 Stream reading completed')
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          chunkCount++
          const now = Date.now()
          console.log(`🟣 Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastChunkTime}ms since last chunk`)
          lastChunkTime = now

          if (chunkCount % 10 === 0) {
            console.log(`🟠 Buffer size: ${buffer.join('').length} characters`)
            logMemoryUsage()
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
            } catch (error) {
              console.error('❌ Error processing line:', error, 'Line content:', line)
            }

            buffer = []
          }
        }
      } catch (error) {
        console.error('❌ Critical error in stream processing:', error)
        if (error.name === 'AbortError') {
          console.error('🚫 Stream processing timed out after', timeoutDuration / 1000, 'seconds')
        }
      } finally {
        clearTimeout(timeoutId)
        console.log('🟢 Stream processing finished')
        console.log(`🟢 Total chunks processed: ${chunkCount}`)
        reader.releaseLock()
      }
    },
  })

  console.log('🟢 Returning stream response')
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
