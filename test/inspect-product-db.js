import "dotenv/config";
import { connectDB } from "../src/db.js";
import Announcement from "../src/models/Announcement.js";
import mongoose from "mongoose";

async function main() {
  await connectDB();
  const announcements = await Announcement.find({}).lean();
  console.log(`Found ${announcements.length} announcements in DB:\n`);
  for (const ann of announcements) {
    console.log(`ID: ${ann._id}`);
    console.log(`Title: ${ann.title}`);
    console.log(`Type: ${ann.type}`);
    console.log(`Product ID: ${ann.productId}`);
    console.log(`Specifications count: ${ann.specifications ? ann.specifications.length : "undefined"}`);
    if (ann.specifications) {
      console.log("Specs:", JSON.stringify(ann.specifications, null, 2));
    }
    console.log("--------------------------------------------------\n");
  }
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
