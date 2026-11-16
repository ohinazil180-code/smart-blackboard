# প্রোডাকশন চেকলিস্ট (কোচিং সেন্টারের জন্য)

- [ ] HTTPS সহ ডোমেইন চালু (যেমন board.yourcoaching.com)
- [ ] ডেস্কটপ ও Android/iOS-এ ইনস্টল ও অফলাইনে খুলে পরীক্ষা
- [ ] বাংলা PDF ইমপোর্ট, OCR, PDF এক্সপোর্ট পরীক্ষা (নমুনা ফাইল দিয়ে)
- [ ] ক্লাস শুরুর আগে JSON ব্যাকআপ নেওয়ার অভ্যাস তৈরি
- [ ] শিক্ষকদের জন্য ৩০ মিনিটের প্রশিক্ষণ
- [ ] আপডেটের পর sw.js-এর VER বাড়ানো
- [ ] ব্রাউজারের "স্টোরেজ পূর্ণ" সতর্কতা থাকলে পুরোনো নোট আর্কাইভ/এক্সপোর্ট করা

## এখন কার্যকর ক্লাসরুম
Teacher private link দিয়ে নিজের room পুনরায় খুলতে পারেন; শিক্ষার্থীরা room code ও display name দিয়ে account ছাড়াই ঢোকে। Neon-backed room state, teacher-only board publishing, student read-only view, reconnect snapshot, group/participant controls, raise-hand queue এবং teacher mic approval API বাস্তবে কাজ করে।

## এই সংস্করণে নেই
- Live audio/video publishing: SFU/media server credentials ও signaling service configured নয়; microphone control queue-তে অনুমতির workflow மட்டுமே পরিচালিত হয়.
- Classroom chat, polls, quizzes, attendance reports, scheduled classes, waiting-room admit controls.
- Board notebook cloud persistence: personal notebook IndexedDB-তে থাকে; teacher board live class room-এ synced হয়, কিন্তু room ended/expired হলে notebook archive হিসেবে থাকে না.

Deploy করার আগে browser-এর বাইরে দুটি session/device দিয়ে teacher link, student code join, board updates, refresh/reconnect এবং role restrictions যাচাই করুন।
