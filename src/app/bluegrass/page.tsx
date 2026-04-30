import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import BluegrassClient from "./BluegrassClient";

export const metadata: Metadata = {
  title: "Party Player",
  description: "Class music remote",
  manifest: "/bluegrass-manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Party Player",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  viewportFit: "cover",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function BluegrassPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/bluegrass")}`);
  }

  const active = await prisma.bluegrassSession.findFirst({
    where: { userId: session.user.id, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return <BluegrassClient initialSession={active} />;
}
