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
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Wordware already started or completed for ${username}`);
    return Response.json({ error: 'Wordware already started' })
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Paid Wordware already started or completed for ${username}`);
    return Response.json({ error: 'Wordware already started' })
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

  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  });

  const decoder = new TextDecoder()
  let accumulatedOutput = '';
  let finalAnalysis = {};
  const existingAnalysis = user?.analysis as TwitterAnalysis;
  let updateAttempted = false;
  let updateSuccessful = false;

  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started');
      const timeout = setTimeout(() => {
        console.log('⚠️ Stream processing timed out');
        controller.close();
      }, 290000); // 290 seconds timeout

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
          accumulatedOutput += chunk;

          const lines = accumulatedOutput.split('\n');
          accumulatedOutput = lines.pop() || '';

          for (const line of lines) {
            if (line.trim() === '') continue;

            try {
              const content = JSON.parse(line);
              const value = content.value;

              if (value.type === 'generation') {
                console.log(`🔵 Generation event: ${value.state} - ${value.label}`);
              } else if (value.type === 'chunk') {
                controller.enqueue(value.value ?? '');
              } else if (value.type === 'outputs') {
                console.log('✨ Received final output from Wordware:', JSON.stringify(value.values.output));
                finalAnalysis = value.values.output;
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
                        ...finalAnalysis,
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
              // Enqueue the line even if there's an error, to ensure we don't lose data
              controller.enqueue(line);
            }
          }
        }
      } catch (error) {
        console.error('❌ Error in stream processing:', error);
      } finally {
        clearTimeout(timeout);
        console.log('🟢 Stream processing finished');
        console.log('Update attempted:', updateAttempted);
        console.log('Update successful:', updateSuccessful);
        console.log('Final analysis:', JSON.stringify(finalAnalysis));
        controller.close();
      }
    },
  });

  console.log('🟢 Returning stream response');
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

function formatTweet(tweet: TweetType) {
  const isRetweet = tweet.isRetweet ? 'RT ' : ''
  const author = tweet.author?.userName ?? ''
  const createdAt = tweet.createdAt
  const text = tweet.text ?? ''
  const formattedText = text.split('\n').map((line) => `${line}`).join(`\n> `)
  return `**${isRetweet}@${author} - ${createdAt}**\n\n> ${formattedText}\n\n*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`
}
