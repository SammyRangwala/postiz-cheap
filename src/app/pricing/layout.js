import { redirect } from "next/navigation";

// The pricing / credit-pack page is only for people reselling this app.
// On a private install it is hidden unless NEXT_PUBLIC_ENABLE_CREDITS=true.
export default function PricingLayout({ children }) {
  if (process.env.NEXT_PUBLIC_ENABLE_CREDITS !== "true") redirect("/");
  return children;
}
