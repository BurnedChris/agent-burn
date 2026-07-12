import { defineSchedule } from "eve/schedules";

import { sendProactiveMessage } from "../lib/bridge-client";
import { getLondonClock, isLondonTime } from "../lib/time";

const SCHEDULE_NAME = "wake-up";

export default defineSchedule({
  // 05:00 Europe/London is 04:00 UTC in BST and 05:00 UTC in GMT.
  cron: "0 4,5 * * *",
  async run() {
    const clock = getLondonClock();

    if (!isLondonTime(clock, 5, 0)) return;

    await sendProactiveMessage({
      message: "Burn Mode active. Water. Stretch. Shoes on. No notifications.",
      idempotencyKey: `schedule:${SCHEDULE_NAME}:${clock.date}`,
    });
  },
});
