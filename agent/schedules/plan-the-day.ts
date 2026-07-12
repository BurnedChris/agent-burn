import { defineSchedule } from "eve/schedules";

import { sendProactiveMessage } from "../channels/sendblue";
import { getLondonClock, isLondonTime } from "../lib/time";

const SCHEDULE_NAME = "plan-the-day";

export default defineSchedule({
  // 08:30 Europe/London is 07:30 UTC in BST and 08:30 UTC in GMT.
  cron: "30 7,8 * * *",
  async run() {
    const clock = getLondonClock();

    if (!isLondonTime(clock, 8, 30)) return;

    await sendProactiveMessage({
      message: "What are the three things that would make today count?",
      idempotencyKey: `schedule:${SCHEDULE_NAME}:${clock.date}`,
    });
  },
});
