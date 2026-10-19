# Kiptenden Youths Pairing Site

Node.js + Express site with WhatsApp pair-code and QR flows, built from the two supplied files.

## Run locally
1. Install Node.js 20 or newer.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

## Deploy on Render
1. Create a GitHub repository and upload the contents of this folder (not the ZIP itself).
2. In Render choose **New + → Web Service** and connect the repository.
3. Set **Runtime** to Node, **Build Command** to `npm install`, **Start Command** to `npm start`.
4. Choose a Node version of 20 or newer if the dashboard offers a version setting.
5. Deploy, then open the Render URL and test `/health`.

## Important
- The web service must remain running while pairing is in progress.
- Do not publish or share generated SESSION_ID values. They grant access to the linked WhatsApp session.
- Use a dedicated WhatsApp account for a bot where possible. Only link an account you own or are authorized to manage.
- This app creates the `SESSION_ID` for your bot; it does not automatically add it to another Render service. Copy it into the bot service's Environment settings as `SESSION_ID`, then redeploy that bot.
- The current pairing implementation stores temporary auth files on local disk and removes them after generating the session. Do not run multiple instances/replicas of this pairing service.
- Before exposing publicly, consider adding an access secret or Cloudflare Access protection. Rate limiting is included but is not a complete abuse-prevention system.
