import { redirect } from "next/navigation";

// The docs index is the landing page.
export default function Home() {
  redirect("/docs");
}
