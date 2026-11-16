# স্মার্ট ব্ল্যাকবোর্ড ও PDF টিচিং স্টুডিও

কোচিং সেন্টারের জন্য responsive Smart Blackboard ও live classroom studio — PC, ট্যাবলেট ও মোবাইলে চলে। ব্যক্তিগত বোর্ড IndexedDB-তে autosave হয়; শিক্ষার্থীরা কোনো email account ছাড়াই room code দিয়ে ঢুকে শিক্ষকের live board দেখতে পারে।

## ফিচার
- Private teacher link ও room-code guest access — sign-in/sign-up ছাড়া; teacher permission server-side signed room session দিয়ে সুরক্ষিত
- Neon Postgres-এ room, group ও participant state; SSE দিয়ে live roster, hand-raise queue এবং teacher board sync
- Teacher-only board publishing এবং student read-only classroom view; reconnect হলে সর্বশেষ board snapshot পুনরায় পাঠানো হয়
- কালো/সাদা বোর্ড: কলম, হাইলাইটার, ইরেজার, আকৃতি, লেখা, আনডু/রিডু, জুম, প্যান
- নোটবুক ও পাতা ব্যবস্থাপনা: টেমপ্লেট, পাতা কপি/মোছা/সরানো
- PDF ইমপোর্ট ও মার্কআপ, ছবি ইমপোর্ট, PDF ও PNG এক্সপোর্ট
- OCR (বাংলা + ইংরেজি) — স্ক্যান করা পাতা থেকে লেখা শনাক্ত
- প্রেজেন্টেশন মোড (লেজার পয়েন্টার সহ)
- JSON ব্যাকআপ ও রিস্টোর — ডেটা হারানোর ঝুঁকি কমাতে নিয়মিত ব্যাকআপ নিন
- অটোসেভ, অফলাইন মোড (PWA — ফোনে "Add to Home screen")

## প্রোডাকশন ডেপ্লয়
শেয়ার করা ক্লাসরুমের জন্য API server ও Neon Postgres-সহ সংযুক্ত Vercel প্রজেক্টে ডেপ্লয় করুন। `DATABASE_URL` এবং কমপক্ষে ৩২ অক্ষরের `BETTER_AUTH_SECRET` (বা আলাদা `ROOM_SESSION_SECRET`) server environment-এ থাকতে হবে; secret কখনও client bundle-এ দেবেন না। Static-only host-এ personal board কাজ করলেও hosted classroom/API চলবে না। HTTPS ব্যবহার করুন, যাতে PWA ও secure host links কাজ করে।

## সার্ভার API পরীক্ষা
রুম সার্ভারের authorization ও microphone approval regression test চালাতে:

```
pnpm --dir server test
```

## পিসিতে পরীক্ষা
```
python3 -m http.server 8000
```
তারপর ব্রাউজারে http://localhost:8000 খুলুন। index.html সরাসরি ফাইল হিসেবে খুললে PDF ও অফলাইন ফিচার কাজ করবে না।

## আপডেট দেওয়ার নিয়ম
নতুন ভার্সন প্রকাশের সময় `sw.js`-এর `VER` (যেমন `sb-v2` → `sb-v3`) বাড়ান। এতে ব্যবহারকারীদের ক্যাশ নতুন হয়ে যাবে।

## ফোল্ডারের কাঠামো
```
index.html            মূল পেজ
css/style.css         স্টাইল
js/                   util, db (IndexedDB), render, app, ui
sw.js                 অফলাইন সার্ভিস ওয়ার্কার
manifest.webmanifest PWA ইনস্টল তথ্য
vendor/               PDF.js, pdf-lib, Tesseract OCR (অফলাইনে চালানোর জন্য)
fonts/                Noto Sans Bengali
icons/                অ্যাপ আইকন
_headers, netlify.toml, vercel.json   হোস্টিং ও নিরাপত্তা হেডার
```

## ব্রাউজার সাপোর্ট
Chrome, Edge, Safari (iOS 16.4+), Firefox — সর্বশেষ সংস্করণ। স্ক্রিন বড় হলে PC/ট্যাবলেটে সবচেয়ে ভালো অভিজ্ঞতা।

## সীমাবদ্ধতা
- Room code দিয়ে join করা শিক্ষার্থী guest; teacher control-এর জন্য সৃষ্টির সময় দেওয়া ব্যক্তিগত host link ব্যবহার করুন। Link যাঁর কাছে থাকবে, তিনি ওই room-এর teacher control পাবেন। Room session ৩০ দিন পর মেয়াদোত্তীর্ণ হয়।
- Room, roster ও board sync-এর জন্য internet এবং Neon-backed server দরকার।
- Voice/video publishing চালু নেই: এই deployment-এ media server/SFU configured নয়; microphone controls শুধু teacher approval queue পরিচালনা করে।
- ব্যক্তিগত নোটবুক ও বোর্ড ডেটা ব্রাউজারের IndexedDB-তে থাকে; ব্রাউজারের ডেটা মুছে গেলে JSON ব্যাকআপ থেকে রিস্টোর করুন।
- ভয়েস/ভিডিও সম্প্রচার আলাদা মিডিয়া সার্ভিস কনফিগার না করা পর্যন্ত চালু হয় না।
