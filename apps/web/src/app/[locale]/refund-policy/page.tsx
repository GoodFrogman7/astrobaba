import { legalMetadata, renderLegalPage, type Props } from "@/components/trust/legalPages";

// Static; the policy registry is re-read from GET /v1/legal at most every 10 minutes (ISR).
export const revalidate = 600;

export async function generateMetadata(props: Props) {
  return legalMetadata(props, "refunds");
}

export default async function Page(props: Props) {
  return renderLegalPage(props, "refunds");
}
