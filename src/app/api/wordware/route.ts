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
  console.log('🟢 | Starting POST handler'); // Log the start of the POST handler

  // Extract username from the request body
  const { username, full } = await request.json()
  console.log('🟢 | Extracted username and full:', { username, full }); // Log extracted data

  // Fetch user data and check if Wordware has already been started
  const user = await getUser({ username })
  console.log('🟢 | Fetched user data:', user); // Log fetched user data

  if (!user) {
    throw Error(`User not found: ${username}`)
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log('🟢 | Wordware already started or completed. Exiting.'); // Log early exit
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log('🟢 | Paid Wordware already started or completed. Exiting.'); // Log early exit for paid
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
  console.log('🟢 | Tweets from user:', tweets); // Log the tweets

  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log('🟢 | Formatted tweets:', tweetsMarkdown); // Log the formatted tweets

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log('🟢 | Using promptID:', promptID); // Log the prompt ID

  // Make a request to the Wordware API
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
  } else {
    console.log('🟢 | Wordware API request succeeded.'); // Log success
  }

  // Proceed if the response is okay
  const reader = runResponse.body?.getReader();
  if (!reader) {
    console.log('❗️ | No reader available in the response');
    return Response.json({ error: 'No reader' }, { status: 400 });
  }

  console.log('🟢 | Reader created. Starting to process the stream.'); // Log reader creation

  // Update user to indicate Wordware has started
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  console.log('🟢 | User updated to indicate Wordware has started.'); // Log user update

  // Set up decoder and buffer for processing the stream
  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis

  // Create a readable stream to process the response
  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 | Stream processing started.'); // Log stream start
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            console.log('🟢 | Stream processing done.'); // Log stream completion
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          console.log('🔵 | Received chunk:', chunk); // Log the entire chunk

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()
            console.log('🔵 | Processed line:', line); // Log each processed line

            // Parse the JSON content of each line
            let content;
            try {
              content = JSON.parse(line);
              console.log('🔵 | Parsed content:', content); // Log the parsed content
            } catch (error) {
              console.error('❗️ | Error parsing JSON:', error);
              continue;
            }

            const value = content.value;
            console.log('🔵 | Parsed value:', value); // Log the value

            // Handle different types of messages in the stream
            if (value.type === 'generation') {
              if (value.state === 'start') {
                if (value.label === 'output') {
                  finalOutput = true;
                }
                console.log('🔵 | New generation started:', value.label);
              } else {
                if (value.label === 'output') {
                  finalOutput = false;
                }
                console.log('🔵 | Generation ended:', value.label);
              }
            } else if (value.type === 'chunk') {
              if (finalOutput) {
                controller.enqueue(value.value ?? '');
              }
            } else if (value.type === 'outputs') {
              console.log('✨ Wordware Outputs:', value.values); // Log the entire values object
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
                console.log('🟢 | Analysis saved to database.');
              } catch (error) {
                console.error('❗️ | Error parsing or saving output:', error);

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

  console.log('🟢 | Returning stream response.'); // Log before returning the stream

  // Return the stream as the response
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
