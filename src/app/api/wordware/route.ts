import { getUser, updateUser } from '@/actions/actions';
import { TweetType } from '@/actions/types';
import { TwitterAnalysis } from '@/components/analysis/analysis';

export const maxDuration = 300;

const TIMEOUT_DURATION = 5 * 60 * 1000; // 5 minutes
const PARTIAL_SAVE_INTERVAL = 60 * 1000; // 1 minute

export async function POST(request: Request) {
  console.log('🟢 Starting POST request for Wordware API');

  const { username, full } = await request.json();
  console.log(`🟢 Processing request for username: ${username}, full: ${full}`);

  const user = await getUser({ username });

  if (!user) {
    console.log(`❌ User not found: ${username}`);
    return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Wordware already started or completed for ${username}`);
    return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 });
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`🟠 Paid Wordware already started or completed for ${username}`);
    return new Response(JSON.stringify({ error: 'Paid Wordware already started' }), { status: 400 });
  }

  function formatTweet(tweet: TweetType) {
    const isRetweet = tweet.isRetweet ? 'RT ' : '';
    const author = tweet.author?.userName ?? username;
    const createdAt = tweet.createdAt;
    const text = tweet.text ?? '';
    const formattedText = text.split('\n').map((line) => `${line}`).join(`\n> `);
    return `**${isRetweet}@${author} - ${createdAt}**\n\n> ${formattedText}\n\n*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`;
  }

  const tweets = user.tweets as TweetType[];
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n');
  console.log(`🟢 Prepared ${tweets.length} tweets for analysis`);

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID;
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
    return new Response(JSON.stringify({ error: 'Wordware API returned an error', details: responseBody }), { status: 400 });
  }

  console.log('🟢 Received successful response from Wordware API');

  console.log('🟢 Updating user to indicate Wordware has started');
  await updateUser({
    user: {
      ...user,
      [full ? 'paidWordwareStarted' : 'wordwareStarted']: true,
      [full ? 'paidWordwareStartedTime' : 'wordwareStartedTime']: new Date(),
    },
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let finalOutput = false;
  let streamedContent = '';
  let chunkCount = 0;
  let lastSaveTime = Date.now();
  let lastLogTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      console.log('🟢 Stream processing started');
      try {
        const reader = runResponse.body?.getReader();
        if (!reader) {
          throw new Error('No reader available in the response');
        }

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Stream processing timed out')), TIMEOUT_DURATION);
        });

        const processingPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              console.log('🟢 Stream reading completed');
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            chunkCount++;

            const currentTime = Date.now();
            if (currentTime - lastLogTime > 5000) {  // Log every 5 seconds
              console.log(`🟣 Processed ${chunkCount} chunks. Last chunk: ${chunk.slice(0, 50)}...`);
              lastLogTime = currentTime;
            }

            buffer += chunk;
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);

              if (line) {
                try {
                  const content = JSON.parse(line);
                  const value = content.value;

                  if (value.type === 'generation') {
                    console.log(`🔵 Generation event: ${value.state} - ${value.label}`);
                    finalOutput = (value.state === 'start' && value.label === 'output');
                  } else if (value.type === 'chunk' && finalOutput) {
                    streamedContent += value.value ?? '';
                    controller.enqueue(value.value ?? '');
                    console.log(`🟢 Streamed chunk: ${(value.value ?? '').slice(0, 50)}...`);
                  } else if (value.type === 'outputs') {
                    console.log('✨ Received final output from Wordware');
                    await handleFinalOutput(value.values.output, user, full, streamedContent);
                  }

                  // Save partial results periodically
                  if (currentTime - lastSaveTime > PARTIAL_SAVE_INTERVAL) {
                    await savePartialResult(user.id, streamedContent);
                    lastSaveTime = currentTime;
                  }
                } catch (error) {
                  console.error('❌ Error processing line:', line, error);
                }
              }
            }
          }
        })();

        await Promise.race([processingPromise, timeoutPromise]);
      } catch (error) {
        console.error('❌ Critical error in stream processing:', error);
        controller.error(error);
      } finally {
        console.log('🟢 Stream processing finished');
        console.log(`🟢 Total chunks processed: ${chunkCount}`);
        console.log(`🟢 Total streamed content length: ${streamedContent.length}`);
        controller.close();
      }
    },
  });

  console.log('🟢 Returning stream response');
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function handleFinalOutput(output: any, user: any, full: boolean, streamedContent: string) {
  try {
    const statusObject = full
      ? { paidWordwareStarted: true, paidWordwareCompleted: true }
      : { wordwareStarted: true, wordwareCompleted: true };
    
    console.log('🟠 Attempting to update user in database with analysis');
    console.log(`🟠 Analysis output keys: ${Object.keys(output).join(', ')}`);
    console.log(`🟠 Streamed content length: ${streamedContent.length}`);

    const updateResult = await updateUser({
      user: {
        ...user,
        ...statusObject,
        analysis: {
          ...user.analysis,
          ...output,
          fullContent: streamedContent, // Store the full streamed content
        },
      },
    });

    console.log('🟢 Database update result:', JSON.stringify(updateResult));
  } catch (error) {
    console.error('❌ Error updating user in database:', error);
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

async function savePartialResult(userId: string, result: string) {
  try {
    // Implement logic to save partial result to database
    // This is a placeholder - replace with actual database update logic
    console.log(`Saved partial result for user ${userId}. Length: ${result.length}`);
  } catch (error) {
    console.error('❌ Error saving partial result:', error);
  }
}
