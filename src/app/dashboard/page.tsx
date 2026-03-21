import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // If Spotify refresh token is revoked, force re-login
  if ((session as any).tokenError === "RefreshTokenRevoked") {
    redirect("/login?error=TokenExpired");
  }

  return <DashboardClient user={session.user} />;
}
