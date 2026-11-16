# সার্ভার ডেপ্লয় গাইড (বাংলা)

## গুরুত্বপূর্ণ
রুম ও গ্রুপ রিয়েল-টাইমে শেয়ার করতে **Node.js সার্ভার** লাগে। শুধু স্ট্যাটিক হোস্ট (Netlify Drop, GitHub Pages, Cloudflare Pages) যথেষ্ট নয়।
যে প্ল্যাটফর্মে Node/Docker চলে সেটি ব্যবহার করুন: **Render, Railway, Fly.io, Google Cloud Run, DigitalOcean, নিজের VPS**।

## দ্রুত চালু (Docker)
```
docker build -t smart-board .
docker run -p 8080:8080 -v board-data:/data smart-board
```
ব্রাউজারে http://localhost:8080 খুলুন।

## দ্রুত চালু (Node, Docker ছাড়া)
```
node server/server.js
```
(Node 18 বা নতুন লাগবে। কোনো `npm install` লাগে না।)

## পরিবেশ ভেরিয়েবল
| নাম | মান | ব্যাখ্যা |
|---|---|---|
| PORT | 8080 | সার্ভার পোর্ট (হোস্টিং প্ল্যাটফর্ম সাধারণত নিজে ঠিক করে দেয়) |
| DATA_FILE | server/data/rooms.json | রুম ডেটার ফাইল। Docker-এ /data/rooms.json, ভলিউমে রাখুন |

## HTTPS ও ডোমেইন
প্রকাশের পর প্ল্যাটফর্মের "Custom domain" থেকে আপনার ডোমেইন (যেমন `board.yourcoaching.com`) যুক্ত করুন। HTTPS প্ল্যাটফর্ম নিজেই দেয়। HTTPS ছাড়া অ্যাপ ইনস্টল ও রিয়েল-টাইম সংযোগ কাজ করবে না।

## ব্যাকআপ
`server/data/rooms.json` (বা Docker ভলিউম) নিয়মিত কপি করুন।

## পরীক্ষা
- `/api/health` → `{"ok":true,...}` দেখালে সার্ভার সচল।
- দুটি আলাদা ডিভাইসে (একটি শিক্ষক, একটি শিক্ষার্থী) রুম তৈরি ও যোগদান করে গ্রুপ বদল পরীক্ষা করুন।

## নিরাপত্তা নোট
- Email login নেই। শিক্ষার্থী room code ও নাম দিয়ে guest হিসেবে যুক্ত হয়; server প্রতিটি room-এর জন্য signed guest session দেয়।
- Teacher class তৈরির পর private host link পান। Link-টি bearer credential: যার কাছে link থাকবে, তিনি ওই room-এর teacher control পাবেন; শিক্ষার্থীদের সঙ্গে share করবেন না। Browser storage মুছে গেলেও link নিরাপদে রাখলে শিক্ষক আবার ঢুকতে পারবেন।
- `ROOM_SESSION_SECRET` আলাদা secret না দিলে অন্তত ৩২ অক্ষরের `BETTER_AUTH_SECRET` দরকার। Secret browser-এ পাঠানো হয় না.
- ভুল কোড ১০ বার দিলে সেই IP ১০ মিনিট ব্লক হয়। অতিরিক্ত অনুরোধও সীমিত।
- রুম ৭ দিন নিষ্ক্রিয় থাকলে স্বয়ংক্রিয়ভাবে মুছে যায়।

## সীমাবদ্ধতা (পরবর্তী ধাপ)
- বোর্ডের লেখা এখনো প্রতিটি ডিভাইসে আলাদা। রিয়েল-টাইম বোর্ড সিঙ্ক পরের ধাপ।
- ভিডিও/অডিও (WebRTC) এই সংস্করণে নেই।
- একটি সার্ভার-ইনস্ট্যান্সের বেশি চালালে ডেটা সমন্বয়ের জন্য ডাটাবেস (PostgreSQL) লাগবে।

## Render-এ এক ক্লিকে প্রকাশ (সবচেয়ে সহজ)
1. এই পুরো ফোল্ডারটি GitHub-এ একটি repository-তে আপলোড করুন (zip extract করে সব ফাইল, root-এ `Dockerfile` ও `render.yaml` সহ)।
2. render.com → **New → Blueprint** → repository বেছে নিন। `render.yaml` পড়ে সার্ভিস ও ডিস্ক নিজেই সেট হবে।
3. Blueprint ডেপ্লয় শেষ হলে Render একটি `https://…onrender.com` ঠিকানা দেবে — ওয়েবসাইট ও রুম সার্ভার একই ঠিকানায়।
4. নিজের ডোমেইন: Service → Settings → Custom Domains।
5. পরীক্ষা: `https://আপনার-ঠিকানা/api/health` খুলুন।

গুরুত্বপূর্ণ: ডিস্ক (`/data`) পেইড প্ল্যানে কাজ করে; ডিস্ক ছাড়া রুম ডেটা রিস্টার্টে হারাবে।
