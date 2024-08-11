import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { unlockPair, unlockUser } from '@/actions/actions';
import { stripe } from '@/lib/stripe';

/**
 * Set of Stripe event types that this webhook handler will process
 */
const relevantEvents = new Set([
  'checkout.session.completed',
]);

/**
 * Handles POST requests for Stripe webhook events
 * @param {Request} req - The incoming request object
 */
export async function POST(req: Request) {
  const body = await req.text();
  const signature = headers().get('Stripe-Signature') as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Log incoming Stripe signature and webhook secret for debugging
  console.log('🟣 | file: route.ts | POST | signature:', signature);
  console.log('🟣 | file: route.ts | POST | webhookSecret:', webhookSecret);

  // Log environment variables related to Stripe
  console.log('🟣 | file: route.ts | STRIPE_PRICE_ID:', process.env.STRIPE_PRICE_ID);
  console.log('🟣 | file: route.ts | STRIPE_PRODUCT_ID:', process.env.STRIPE_PRODUCT_ID);

  let event: Stripe.Event;

  try {
    // Verify and construct the Stripe event
    if (!signature || !webhookSecret) {
      console.error('❗️ Missing Stripe signature or webhook secret.');
      return new Response('Missing Stripe signature or webhook secret.', { status: 400 });
    }

    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    console.log('🟣 | file: route.ts | POST | Constructed Stripe Event:', event);

  } catch (err: any) {
    console.warn('❗️ Webhook Error:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Process the event if it's one we're interested in
  if (relevantEvents.has(event.type)) {
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          const checkoutSession = event.data.object as Stripe.Checkout.Session;
          console.log('🟣 Checkout Session Completed:', checkoutSession);

          // Log metadata for debugging
          console.log('🟣 | file: route.ts | Checkout Session Metadata:', checkoutSession.metadata);

          if (checkoutSession.metadata?.type === 'pair') {
            const [username1, username2] = [checkoutSession.metadata.username1, checkoutSession.metadata.username2].sort();
            console.log('Webhook: UNLOCKING PAIR:', username1, username2);
            await unlockPair({ username1, username2, unlockType: 'stripe' });
          }
          if (checkoutSession.metadata?.type === 'user') {
            console.log('Webhook: UNLOCKING USER:', checkoutSession.metadata.username);
            await unlockUser({ username: checkoutSession.metadata.username, unlockType: 'stripe' });
            revalidatePath(`/${checkoutSession.metadata.username}`);
          }
          break;
        default:
          console.error('❗️ Unhandled relevant event:', event.type);
          throw new Error('Unhandled relevant event!');
      }
    } catch (error) {
      console.warn('❗️ Webhook handler failed:', error);
      return new Response('Webhook handler failed. View your next.js function logs.', {
        status: 400,
      });
    }
  }

  // Acknowledge receipt of the event
  return NextResponse.json({ received: true });
}
