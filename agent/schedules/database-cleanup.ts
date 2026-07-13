import { defineSchedule } from "eve/schedules";

import { cleanupExpiredChatState } from "../lib/db/cleanup";

export default defineSchedule({
  cron: "17 * * * *",
  async run() {
    await cleanupExpiredChatState();
  },
});
