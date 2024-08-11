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
  console.log('🟢 | POST handler called')

  // Extract username from the request body
  let username, full;
  try {
    const requestBody = await request.json()
    username = requestBody.username
    full = requestBody.full
    console.log('🟢 | Extracted from request body:', { username, full })
  } catch (error) {
    console.error('❗️ | Error parsing request body:', error)
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Fetch user data and check if Wordware has already been started
  let user;
  try {
    user = await getUser({ username })
    if (!user) throw new Error(`User not found: ${username}`)
    console.log('🟢 | Fetched user data:', user)
  } catch (error) {
    console.error('❗️ | Error fetching user:', error.message)
    return Response.json({ error: error.message }, { status: 400 })
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log('🟡 | Wordware already started or completed for user:', username)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log('🟡 | Paid Wordware already started or completed for user:', username)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  function formatTweet(tweet: TweetType) {
    console.log('🔵 | Formatting tweet:', tweet)
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
  console.log('🟢 | Formatting tweets:', tweets)
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log('🟢 | Formatted tweets markdown:', tweetsMarkdown)

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log('🟢 | Using prompt ID:', promptID)

  // Make a request to the Wordware API
  let runResponse;
  try {
    runResponse = await fetch(`https://app.wordware.ai/api/released-app/${promptID}/run`, {
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
    console.log('🟢 | Received response from Wordware API:', runResponse)
  } catch (error) {
    console.error('❗️ | Error making request to Wordware API:', error)
    return Response.json({ error: 'Failed to contact Wordware API' }, { status: 500 })
  }

  if (!runResponse.ok) {
    console.log('🟣 | ERROR | file: route.ts:40 | POST | runResponse:', runResponse)
    return Response.json({ error: 'Wordware API returned an error' }, { status: 400 })
  }

  // Get the reader from the response body
  const reader = runResponse.body?.getReader()
  if (!reader) {
    console.log('❗️ | No reader available in the response')
    return Response.json({ error: 'No reader' }, { status: 400 })
  }

  // Update user to indicate Wordware has started
  try {
    await updateUser({
      user: {
        ...user,
        wordwareStarted: true,
        wordwareStartedTime: new Date(),
      },
    })
    console.log('🟢 | Updated user after Wordware started')
  } catch (error) {
    console.error('❗️ | Error updating user:', error)
    return Response.json({ error: 'Failed to update user' }, { status: 500 })
  }

  // Set up decoder and buffer for processing the stream
  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis

  // Create a readable stream to process the response
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            console.log('🔵 | Stream done reading')
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          console.log('🔵 | Processing chunk:', chunk)

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            // Parse the JSON content of each line
            let content;
            try {
              content = JSON.parse(line)
              console.log('🔵 | Parsed content:', content)
            } catch (error) {
              console.error('❗️ | Error parsing JSON:', error)
              continue
            }
            const value = content.value

            // Handle different types of messages in the stream
            if (value.type === 'generation') {
              if (value.state === 'start') {
                if (value.label === 'output') {
                  finalOutput = true
                }
                console.log('\nNEW GENERATION -', value.label)
              } else {
                if (value.label === 'output') {
                  finalOutput = false
                }
                console.log('\nEND GENERATION -', value.label)
              }
            } else if (value.type === 'chunk') {
              if (finalOutput) {
                controller.enqueue(value.value ?? '')
              }
            } else if (value.type === 'outputs') {
              console.log('✨ Wordware:', value.values.output, '. Now parsing')
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
                console.log('🟢 | Analysis saved to database')
              } catch (error) {
                console.error('❗️ | Error parsing or saving output:', error)

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
              }
            }

            // Reset buffer for the next line
            buffer = []
          }
        }
      } finally {
        // Ensure the reader is released when done
        reader.releaseLock()
      }
    },
  })

  // Return the stream as the response
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
