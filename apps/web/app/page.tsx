// Placeholder root — redirects into the dashboard.
// Replaced with a real system-status dashboard in M2.
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/agents");
}
