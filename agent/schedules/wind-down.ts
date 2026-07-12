import { defineSchedule } from "eve/schedules";

import { sendProactiveMessage } from "../lib/bridge-client";
import { getLondonClock, isLondonTime } from "../lib/time";

const SCHEDULE_NAME = "wind-down";

export default defineSchedule({
  // 20:45 Europe/London is 19:45 UTC in BST and 20:45 UTC in GMT.
  cron: "45 19,20 * * *",
  async run() {
    const clock = getLondonClock();

    if (!isLondonTime(clock, 20, 45)) return;

    await sendProactiveMessage({
      message:
        "Burn Mode starts tomorrow tonight. Close the loops, prepare your clothes, fill your water bottle, phone down.",
      idempotencyKey: `schedule:${SCHEDULE_NAME}:${clock.date}`,
    });
  },
});
