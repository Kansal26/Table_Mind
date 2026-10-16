import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const parseVoiceOrderSchema = z.object({
  qrToken: z.string().min(1).max(200),
  transcript: z.string().min(1).max(2000),
});

export const parseVoiceOrderFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseVoiceOrderSchema.parse(data))
  .handler(async ({ data }) => {
    const { getClientIdentifier, rateLimit } = await import("./rate-limit.server");
    const clientId = getClientIdentifier();
    await rateLimit(clientId, "parseVoiceOrder", 15, 60 * 1000);

    const { parseVoiceTranscript } = await import("./voice.server");
    return parseVoiceTranscript(data.qrToken, data.transcript);
  });
