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
  console.log('🟢 Starting POST request for Wordware API');
  
  // Extract username from the request body
  const { username, full } = await request.json()
  console.log(`🟢 Processing request for username: ${username}, full: ${full}`);

  // Fetch user data and check if Wordware has already been started
  const user = await getUser({ username })

  if (!user) {
    console.log(`❌ User not found: ${username}`);
    throw Error(`User not found: ${username}`)
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Wordware already started or completed for ${username}`);
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`🟠 Paid Wordware already started or completed for ${username}`);
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
  console.log(`🟢 Prepared ${tweets.length} tweets for analysis`);

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`🟢 Using promptID: ${promptID}`);

  // Make a request to the Wordware API
  console.log('🟢 Sending request to Wordware API');
  const runResponse = await fetch(`https://app.wordware.ai/api/released-app/${promptID}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {
        Tweets: tweetsMarkdown, // Note the capital 'T' and no "Tweets:" prefix
        profilePicture: user.profilePicture,
        profileInfo: user.fullProfile,
        version: '^2.0',
      },
    }),
  });

  // Log the response status and body
  if (!runResponse.ok) {
    const responseBody = await runResponse.text();  // Read the response body
    console.log('🟣 | ERROR | file: route.ts:40 | POST | runResponse:', runResponse);
    console.log('🟣 | Response Body:', responseBody);  // Log the response body
    return Response.json({ error: 'Wordware API returned an error', details: responseBody }, { status: 400 });
  }
  console.log('🟢 Received successful response from Wordware API');

  // Proceed if the response is okay
  const reader = runResponse.body?.getReader();
  if (!reader) {
    console.log('❗️ | No reader available in the response');
    return Response.json({ error: 'No reader' }, { status: 400 });
  }

  console.log('🟢 Updating user to indicate Wordware has started');
  // Update user to indicate Wordware has started
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
  let updateAttempted = false;
  let updateSuccessful = false;

  // Create a readable stream to process the response
  console.log('🟢 Starting to process the stream');
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            console.log('🟢 Stream processing completed');
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          // console.log('🟣 | file: route.ts:80 | start | chunk:', chunk)

          // Process the chunk line by line
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.trim() === '') continue

            // Parse the JSON content of each line
            const content = JSON.parse(line)
            const value = content.value

            // Handle different types of messages in the stream
            if (value.type === 'generation') {
              console.log(`🔵 Generation event: ${value.state} - ${value.label}`);
              if (value.state === 'start') {
                if (value.label === 'output') {
                  finalOutput = true
                }
                // console.log('\nNEW GENERATION -', value.label)
              } else {
                if (value.label === 'output') {
                  finalOutput = false
                }
                // console.log('\nEND GENERATION -', value.label)
              }
            } else if (value.type === 'chunk') {
              if (finalOutput) {
                controller.enqueue(value.value ?? '')
              }
            } else if (value.type === 'outputs') {
              console.log('✨ Received final output from Wordware. Now parsing');
              updateAttempted = true;
              try {
                const statusObject = full
                  ? {
                      paidWordwareStarted: true,
                      paidWordwareCompleted: true,
                    }
                  : { wordwareStarted: true, wordwareCompleted: true }
                // Update user with the analysis from Wordware
                console.log('🟠 Attempting to update user in database');
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
                updateSuccessful = true;
                console.log('🟢 Successfully updated user in database');
              } catch (error) {
                console.error('❌ Error updating user in database:', error)
                updateSuccessful = false;

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
                console.log('🟠 Updated user status to indicate failure');
              }
            }
          }
        }
      } finally {
        // Ensure the reader is released when done
        reader.releaseLock()
        console.log('🟢 Stream processing finished');
        console.log(`🟢 Update attempted: ${updateAttempted}, Update successful: ${updateSuccessful}`);
      }
    },
  })

  console.log('🟢 Returning stream response');
  // Return the stream as the response
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
