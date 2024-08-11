import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

export const maxDuration = 300

export async function POST(request: Request) {
  console.log('🟢 Starting POST request for Wordware API');

  const { username, full } = await request.json()
  console.log(`🟢 Processing request for username: ${username}, full: ${full}`);

  const user = await getUser({ username })

  if (!user) {
    console.log(`❌ User not found: ${username}`);
    throw Error(`User not found: ${username}`)
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Wordware already started or completed for ${username}`);
    return Response.json({ error: 'Wordware already started' })
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Paid Wordware already started or completed for ${username}`);
    return Response.json({ error: 'Wordware already started' })
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
  console.log(`🟢 Prepared ${tweets.length} tweets for analysis`);

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`🟢 Using promptID: ${promptID}`);

  console.log('🟢 Sending request to Wordware API');
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
        version: '^3.2',
      },
    }),
  });

  if (!runResponse.ok) {
    const responseBody = await runResponse.text();
    console.log('🟣 | ERROR | Wordware API Error:', runResponse.status, responseBody);
    return Response.json({ error: 'Wordware API returned an error', details: responseBody }, { status: 400 });
  }

  console.log('🟢 Received successful response from Wordware API');

  console.log('🟢 Updating user to indicate Wordware has started');
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  });

    const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let updateAttempted = false
  let updateSuccessful = false

  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started');
      try {
        const reader = runResponse.body?.getReader();
        if (!reader) {
          throw new Error('No reader available in the response');
        }

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            console.log('🟢 Stream reading completed');
            break;
          }

          const chunk = decoder.decode(value);
          console.log('🟣 Received chunk:', chunk);

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()
            console.log('🔵 Processed line:', line);

            try {
              const content = JSON.parse(line)
              const value = content.value

              if (value.type === 'generation') {
                console.log(`🔵 Generation event: ${value.state} - ${value.label}`);
                finalOutput = (value.state === 'start' && value.label === 'output');
              } else if (value.type === 'chunk' && finalOutput) {
                controller.enqueue(value.value ?? '')
              } else if (value.type === 'outputs') {
                console.log('✨ Received final output from Wordware:', JSON.stringify(value.values.output));
                updateAttempted = true;
                try {
                  const statusObject = full
                    ? { paidWordwareStarted: true, paidWordwareCompleted: true }
                    : { wordwareStarted: true, wordwareCompleted: true };
                  
                  console.log('🟠 Attempting to update user in database with analysis');
                  const updateResult = await updateUser({
                    user: {
                      ...user,
                      ...statusObject,
                      analysis: {
                        ...existingAnalysis,
                        ...value.values.output,
                      },
                    },
                  });

                  console.log('🟢 Database update result:', JSON.stringify(updateResult));
                  updateSuccessful = true;
                } catch (error) {
                  console.error('❌ Error updating user in database:', error);
                  updateSuccessful = false;
                  
                  await updateUser({
                    user: {
                      ...user,
                      ...(full 
                        ? { paidWordwareStarted: false, paidWordwareCompleted: false }
                        : { wordwareStarted: false, wordwareCompleted: false }),
                    },
                  });
                  console.log('🟠 Updated user status to indicate failure');
                }
              }
            } catch (error) {
              console.error('❌ Error processing line:', line, error);
            }

            // Reset buffer for the next line
            buffer = []
          }
        }
      } catch (error) {
        console.error('❌ Error in stream processing:', error);
      } finally {
        console.log('🟢 Stream processing finished');
        console.log('Update attempted:', updateAttempted);
        console.log('Update successful:', updateSuccessful);
        controller.close();
      }
    },
  });

  console.log('🟢 Returning stream response');
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

