import { legalMetadata, renderLegalPage, type Props } from "@/components/trust/legalPages";

// Static; the policy registry (GET /v1/legal) and the helplines (GET /v1/safety/resources) are
// re-read at most every 10 minutes (ISR).
export const revalidate = 600;

export async function generateMetadata(props: Props) {
  return legalMetadata(props, "safety");
}

export default async function Page(props: Props) {
  return renderLegalPage(props, "safety");
}
