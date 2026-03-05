import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return <DashboardClient user={session.user} />;
}
