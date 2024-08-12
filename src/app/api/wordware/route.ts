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
    throw Error(`User not found: ${username}`)
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    return Response.json({ error: 'Wordware already started' })
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    return Response.json({ error: 'Paid Wordware already started' })
  }

  function formatTweet(tweet: TweetType) {
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
    const createdAt = tweet.createdAt
    const text = tweet.text ?? ''
    const formattedText = text.split('\n').map((line) => `${line}`).join(`\n> `)
    return `**${isRetweet}@${author} - ${createdAt}**\n\n> ${formattedText}\n\n*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`
  }

  const tweets = user.tweets as TweetType[]
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log(`🟢 Prepared ${tweets.length} tweets for analysis`)

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`🟢 Using promptID: ${promptID}`)

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
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0

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
          if (chunkCount % 10 === 0) {
            console.log(`🟣 Processed ${chunkCount} chunks`)
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
                finalOutput = (value.state === 'start' && value.label === 'output')
              } else if (value.type === 'chunk' && finalOutput) {
                controller.enqueue(value.value ?? '')
              } else if (value.type === 'outputs') {
                console.log('✨ Received final output from Wordware')
                await handleFinalOutput(value.values.output, user, full, existingAnalysis)
              }
            } catch (error) {
              console.error('❌ Error processing line:', line, error)
            }

            buffer = []
          }
        }
      } catch (error) {
        console.error('❌ Error in stream processing:', error)
      } finally {
        console.log('🟢 Stream processing finished')
        console.log(`🟢 Total chunks processed: ${chunkCount}`)
        reader.releaseLock()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}

async function handleFinalOutput(output: any, user: any, full: boolean, existingAnalysis: TwitterAnalysis) {
  try {
    const statusObject = full
      ? { paidWordwareStarted: true, paidWordwareCompleted: true }
      : { wordwareStarted: true, wordwareCompleted: true }
    
    console.log('🟠 Attempting to update user in database with analysis')
    console.log(`🟠 Analysis output keys: ${Object.keys(output).join(', ')}`)

    const updateResult = await updateUser({
      user: {
        ...user,
        ...statusObject,
        analysis: {
          ...existingAnalysis,
          ...output,
        },
      },
    })

    console.log('🟢 Database update successful')
  } catch (error) {
    console.error('❌ Error updating user in database:', error)
    await updateUser({
      user: {
        ...user,
        ...(full 
          ? { paidWordwareStarted: false, paidWordwareCompleted: false }
          : { wordwareStarted: false, wordwareCompleted: false }),
      },
    })
    console.log('🟠 Updated user status to indicate failure')
  }
}
