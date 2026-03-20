import webpush from "web-push";
import { prisma } from "./db";

if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:jonathandanfuller@gmail.com",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

export async function sendPushToHost(
  roomId: string,
  payload: { title: string; body: string; icon?: string; url?: string }
) {
  if (!process.env.VAPID_PRIVATE_KEY) return;
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { hostPushSubscription: true },
  });
  if (!room?.hostPushSubscription) return;
  try {
    const subscription = JSON.parse(room.hostPushSubscription);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err: any) {
    if (err?.statusCode === 410) {
      await prisma.room.update({
        where: { id: roomId },
        data: { hostPushSubscription: null },
      });
    }
  }
}
