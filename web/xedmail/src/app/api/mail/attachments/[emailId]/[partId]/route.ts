export const runtime = "nodejs";
import { requireUserId } from "@/lib/api-auth";

const ELYSIA_URL = process.env.ELYSIA_SERVICE_URL!;
const SERVICE_SECRET = process.env.ELYSIA_SERVICE_SECRET!;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ emailId: string; partId: string }> }
) {
  await requireUserId();
  const { emailId, partId } = await params;
  return fetch(`${ELYSIA_URL}/attachments/${emailId}/${partId}`, {
    headers: { "x-service-secret": SERVICE_SECRET },
    cache: "no-store",
  });
}
