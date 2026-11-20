const config = {
  appName: "Free Ai Social Media Scheduler",
  auth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    secret: process.env.NEXTAUTH_SECRET,
    url: process.env.NEXTAUTH_URL || "http://localhost:3000",
    webhook_url: process.env.WEBHOOK_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
  },
  stripe: {
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    plans: {
      starter: {
        id: "starter",
        name: "Starter Pack",
        credits: 100,
        price: 500, // $5.00
      },
      pro: {
        id: "pro",
        name: "Pro Pack",
        credits: 500,
        price: 1500, // $15.00
      },
      business: {
        id: "business",
        name: "Business Pack",
        credits: 2000,
        price: 4500, // $45.00
      }
    }
  },
  ai: {
    apiKey: process.env.MUAPIAPP_API_KEY,
    generationCost: 1, // Deducted per social post trigger
  },
  credits: {
    // The in-app credit system is for people reselling this app. On a private
    // self-hosted install it would silently stop publishing after 10 posts,
    // so it stays off unless ENABLE_CREDITS=true.
    enabled: process.env.ENABLE_CREDITS === "true",
  }
};

export default config;
