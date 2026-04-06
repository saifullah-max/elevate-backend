import { promises as fs } from "fs";
import path from "path";

export type LegalDocumentSlug =
  | "terms-of-use"
  | "privacy-policy"
  | "cancellation-policy"
  | "cookie-policy"
  | "copyright-policy"
  | "disclaimer"
  | "support";

export interface LegalDocumentRecord {
  slug: LegalDocumentSlug;
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface LegalDocumentsStore {
  documents: LegalDocumentRecord[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "legal-documents.json");

const nowIso = () => new Date().toISOString();

const DEFAULT_LEGAL_DOCUMENTS: Array<Omit<LegalDocumentRecord, "updatedAt" | "updatedBy">> = [
  {
    slug: "terms-of-use",
    title: "Terms of Use",
    description: "Rules, conditions, and legal obligations governing use of Elevate Spaces.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>TERMS OF SERVICE</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <h3>1. Acceptance of Terms</h3>
      <p>These Terms constitute a legally binding agreement between you (“User”) and Elevate Spaces AI, LLC (“Elevate Spaces”).</p>
      <p>By accessing or using the Services, you acknowledge that you have read, understood, and agree to be bound by these Terms and the Privacy Policy.</p>
      <p>If you do not agree, you must immediately discontinue use of the Services.</p>
      <p>Elevate Spaces reserves the right to modify these Terms at any time. Continued use following modification constitutes acceptance.</p>
      <h3>2. Description of Services</h3>
      <p>Elevate Spaces provides AI-powered visualization tools and a digital marketplace connecting customers with independent photographers.</p>
      <p>Elevate Spaces is solely a technology platform.</p>
      <p><strong>Scope of Services</strong></p>
      <p>The Services are designed and intended primarily for hospitality and commercial design industries, including hotels, resorts, extended-stay accommodations, and commercial interior design projects.</p>
      <p>The Services are not marketed, positioned, or branded as residential real estate listing media or MLS listing services.</p>
      <p>Elevate Spaces does not actively solicit residential real estate agents or homeowners for listing-related staging services.</p>
      <p>Elevate Spaces is not:</p>
      <ul>
        <li>A real estate brokerage</li>
        <li>A licensed contractor</li>
        <li>An architectural or engineering firm</li>
        <li>A photography provider</li>
        <li>A bank, escrow agent, trustee, or financial institution</li>
      </ul>
      <p>All AI-generated outputs are digital visualizations for marketing and illustrative purposes only.</p>
      <h3>3. Eligibility</h3>
      <p>You represent and warrant that you are at least eighteen (18) years old and legally capable of entering into a binding contract.</p>
      <h3>4. Account Responsibility</h3>
      <p>You are solely responsible for all activities under your account.</p>
      <p>Elevate Spaces may suspend, restrict, or terminate accounts for fraud, abuse, chargebacks, violations, or suspected unlawful conduct.</p>
      <h3>5. User Content and License</h3>
      <p>You retain ownership of User Content.</p>
      <p>You grant Elevate Spaces a worldwide, non-exclusive, royalty-free, sublicensable license to use, process, reproduce, modify, display, and store User Content solely for operation and improvement of the Services.</p>
      <p>You represent and warrant that you possess all rights necessary to grant this license.</p>
      <h3>6. Artificial Intelligence Disclaimer</h3>
      <p>AI-generated outputs:</p>
      <ul>
        <li>May contain inaccuracies or distortions</li>
        <li>May not reflect actual structural conditions</li>
        <li>Are not architectural, engineering, legal, or regulatory advice</li>
        <li>Are not guaranteed</li>
      </ul>
      <p>You assume full responsibility for verification before use.</p>
      <h3>7. Photographer Marketplace</h3>
      <p>Photographers listed on the platform are independent contractors and not employees, agents, partners, joint venturers, or representatives of Elevate Spaces.</p>
      <p>Nothing in these Terms shall be construed to create any employment, partnership, agency, joint venture, fiduciary, or similar relationship between Elevate Spaces and any photographer.</p>
      <p>Elevate Spaces does not:</p>
      <ul>
        <li>Supervise, control, or direct photographer services</li>
        <li>Guarantee bookings, availability, or income</li>
        <li>Guarantee service quality or outcomes</li>
        <li>Verify licensing, insurance, or qualifications beyond platform requirements</li>
        <li>Assume responsibility for the acts or omissions of photographers</li>
      </ul>
      <p><strong>Third-Party Services Disclaimer</strong></p>
      <p>All photographer services are provided solely by independent third parties.</p>
      <p>You acknowledge and agree that:</p>
      <ul>
        <li>Any engagement with a photographer is undertaken at your own risk</li>
        <li>Elevate Spaces makes no representations or warranties regarding quality, safety, timeliness, legality, or performance</li>
        <li>Elevate Spaces is not responsible for property damage, personal injury, service dissatisfaction, missed appointments, delays, cancellations, or failure to deliver services</li>
      </ul>
      <p>Your sole remedy for dissatisfaction with photographer services is directly against the photographer.</p>
      <p>Elevate Spaces shall not be liable for any losses, damages, claims, or disputes arising out of or relating to services performed by photographers.</p>
      <h3>8. Payments, Credits, and Subscriptions</h3>
      <h4>8.1 Credit System</h4>
      <p>Credits:</p>
      <ul>
        <li>Reset monthly</li>
        <li>Do not roll over</li>
        <li>Expire if unused</li>
        <li>Have no cash value</li>
        <li>Are non-transferable</li>
        <li>Are non-refundable except as required by law</li>
      </ul>
      <h4>8.2 Subscriptions and Automatic Renewal</h4>
      <p>Subscription plans are billed in advance on a recurring basis.</p>
      <p>By purchasing a subscription, you authorize Elevate Spaces and its third-party payment processors to automatically charge your payment method at the beginning of each billing cycle unless canceled prior to renewal.</p>
      <p>Subscriptions automatically renew at the end of each billing period unless canceled before the renewal date.</p>
      <p>Failure to cancel prior to renewal does not entitle you to a refund.</p>
      <p>We do not provide prorated refunds for partial billing periods.</p>
      <p>Credits associated with subscription plans are issued monthly and expire at the end of the billing cycle.</p>
      <h4>8.3 Payment Authorization</h4>
      <p>You agree to provide current, complete, and accurate billing information.</p>
      <p>You authorize Elevate Spaces and its processors to charge applicable fees.</p>
      <h4>8.4 Failed Payments</h4>
      <p>If payment cannot be processed:</p>
      <ul>
        <li>Access may be suspended</li>
        <li>Credits may not be issued</li>
        <li>We may retry payment</li>
        <li>Subscription may be terminated</li>
      </ul>
      <h3>9. Marketplace Payments &amp; Photographer Payouts</h3>
      <p>Elevate Spaces acts solely as a limited payment facilitator.</p>
      <p>Elevate Spaces does not hold funds in escrow and assumes no fiduciary obligation.</p>
      <p>Elevate Spaces may:</p>
      <ul>
        <li>Delay payouts pending investigation</li>
        <li>Deduct platform and processing fees</li>
        <li>Offset refunds or chargebacks</li>
        <li>Recover funds previously paid</li>
      </ul>
      <p>Payout timing is not guaranteed.</p>
      <p>Photographers are solely responsible for taxes and compliance.</p>
      <h3>10. Refund Policy</h3>
      <p>Refund requests must be submitted within seven (7) calendar days of purchase.</p>
      <p>Eligibility requires:</p>
      <ul>
        <li>No more than ten (10) generated images</li>
      </ul>
      <p>Subscription renewals, upgrades, and add-ons are non-refundable.</p>
      <p>Initiating a chargeback without first contacting support constitutes breach of these Terms.</p>
      <h3>11. Prohibited Conduct</h3>
      <p>You shall not:</p>
      <ul>
        <li>Upload unlawful or infringing content</li>
        <li>Misrepresent AI outputs</li>
        <li>Circumvent payment systems</li>
        <li>Reverse engineer the platform</li>
        <li>Solicit off-platform payments</li>
        <li>Engage in fraudulent activity</li>
      </ul>
      <h3>12. Disclaimer of Warranties</h3>
      <p>THE SERVICES ARE PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR RELIABILITY.</p>
      <h3>13. Limitation of Liability</h3>
      <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW:</p>
      <p>IN NO EVENT SHALL ELEVATE SPACES BE LIABLE FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, EXEMPLARY, OR PUNITIVE DAMAGES.</p>
      <p>TOTAL LIABILITY SHALL NOT EXCEED THE GREATER OF:</p>
      <p>(A) THE TOTAL AMOUNT PAID BY YOU IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM; OR (B) ONE HUNDRED U.S. DOLLARS (USD $100).</p>
      <p>YOUR SOLE AND EXCLUSIVE REMEDY IS TO DISCONTINUE USE OF THE SERVICES.</p>
      <h3>14. Indemnification</h3>
      <p>You agree to defend, indemnify, and hold harmless Elevate Spaces from claims arising from:</p>
      <ul>
        <li>User Content</li>
        <li>Marketplace disputes</li>
        <li>Regulatory violations</li>
        <li>Misuse of the Services</li>
      </ul>
      <h3>15. Governing Law</h3>
      <p>These Terms are governed by the laws of the State of Ohio.</p>
      <h3>16. Binding Arbitration and Jury Trial Waiver</h3>
      <p>Any dispute shall be resolved exclusively by final and binding arbitration in Ohio.</p>
      <p>Arbitration shall be conducted on an individual basis only.</p>
      <p>You waive any right to a jury trial or to participate in class, collective, or representative actions.</p>
      <h3>17. Survival</h3>
      <p>Provisions relating to liability, arbitration, indemnification, and payment obligations survive termination.</p>
      <h3>18. Force Majeure</h3>
      <p>Elevate Spaces shall not be liable for delays or failures caused by events beyond reasonable control.</p>
      <h3>19. Severability</h3>
      <p>If any provision is unenforceable, the remainder remains in effect.</p>
      <h3>20. No Waiver</h3>
      <p>Failure to enforce any provision shall not constitute a waiver.</p>
      <h3>21. Entire Agreement</h3>
      <p>These Terms constitute the entire agreement between the parties.</p>
    `,
  },
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    description: "How Elevate Spaces collects, uses, stores, and protects personal information.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>PRIVACY POLICY</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <h3>1. Introduction</h3>
      <p>This Privacy Policy describes how Elevate Spaces AI, LLC (“Elevate Spaces,” “Company,” “we,” “us,” or “our”) collects, uses, stores, processes, and discloses information in connection with your access to and use of our website, platform, marketplace, and related services (collectively, the “Services”).</p>
      <p>By accessing or using the Services, you consent to the practices described herein.</p>
      <h3>2. Information We Collect</h3>
      <h4>2.1 Information You Provide</h4>
      <p>We may collect:</p>
      <ul>
        <li>Name</li>
        <li>Email address</li>
        <li>Account credentials</li>
        <li>Uploaded images and project data</li>
        <li>Billing information</li>
        <li>Marketplace communications</li>
        <li>Any information voluntarily submitted</li>
      </ul>
      <h4>2.2 Automatically Collected Information</h4>
      <p>We may automatically collect:</p>
      <ul>
        <li>IP address</li>
        <li>Device identifiers</li>
        <li>Browser type</li>
        <li>Usage logs</li>
        <li>Session data</li>
        <li>Cookie data</li>
      </ul>
      <h4>2.3 Payment Information</h4>
      <p>Payment transactions are processed through third-party payment processors. Elevate Spaces does not store full credit card numbers.</p>
      <h3>3. How We Use Information</h3>
      <p>We use collected information to:</p>
      <ul>
        <li>Provide and operate the Services</li>
        <li>Process payments and marketplace payouts</li>
        <li>Prevent fraud, abuse, and chargebacks</li>
        <li>Improve system performance</li>
        <li>Comply with legal obligations</li>
        <li>Enforce our Terms of Service</li>
      </ul>
      <p>We may use anonymized and aggregated data for analytics and system improvement.</p>
      <h3>4. Disclosure of Information</h3>
      <p>We may disclose information to:</p>
      <ul>
        <li>Payment processors</li>
        <li>Cloud hosting providers</li>
        <li>Analytics providers</li>
        <li>Identity verification providers</li>
        <li>Legal authorities when required by law</li>
        <li>Professional advisors</li>
      </ul>
      <p>We do not sell personal information.</p>
      <h3>5. Data Retention</h3>
      <p>We retain information for as long as reasonably necessary to:</p>
      <ul>
        <li>Provide Services</li>
        <li>Enforce agreements</li>
        <li>Resolve disputes</li>
        <li>Prevent fraud</li>
        <li>Comply with legal obligations</li>
      </ul>
      <h3>6. Security</h3>
      <p>We implement commercially reasonable administrative, technical, and physical safeguards. However, no system can guarantee absolute security.</p>
      <h3>7. User Rights</h3>
      <p>Subject to applicable law, you may request access, correction, or deletion of personal information by contacting:</p>
      <p><strong>elevatespacesai@gmail.com</strong></p>
      <p>We may require identity verification prior to fulfilling requests.</p>
      <h3>8. International Data Transfers</h3>
      <p>By using the Services, you consent to processing and storage of data in the United States.</p>
    `,
  },
  {
    slug: "cancellation-policy",
    title: "Cancellation & Refund",
    description: "Cancellation rights, refund rules, and chargeback consequences for Elevate Spaces purchases.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>CANCELLATION &amp; REFUND POLICY</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <h3>1. Subscription Cancellation</h3>
      <p>Subscriptions may be canceled at any time via account settings.</p>
      <p>Cancellation prevents future renewals but does not entitle the user to a refund of the current billing period.</p>
      <p>Access remains active until the end of the billing cycle.</p>
      <h3>2. Refund Eligibility</h3>
      <p>Refund requests must be submitted within seven (7) calendar days of initial purchase.</p>
      <p>Refund eligibility requires:</p>
      <ul>
        <li>No more than ten (10) generated images</li>
        <li>No more than two (2) generated videos</li>
        <li>No more than two (2) panorama outputs</li>
      </ul>
      <p>If usage exceeds these limits, the purchase is non-refundable.</p>
      <h3>3. Non-Refundable Transactions</h3>
      <p>The following are strictly non-refundable:</p>
      <ul>
        <li>Subscription renewals</li>
        <li>Plan upgrades</li>
        <li>Add-ons</li>
        <li>Prorated charges</li>
        <li>Expired credits</li>
        <li>Dissatisfaction based solely on aesthetic preference</li>
      </ul>
      <h3>4. Chargebacks</h3>
      <p>Initiating a chargeback without first contacting support constitutes breach of the Terms of Service and may result in:</p>
      <ul>
        <li>Immediate suspension</li>
        <li>Revocation of credits</li>
        <li>Recovery of funds</li>
        <li>Permanent account termination</li>
      </ul>
    `,
  },
  {
    slug: "cookie-policy",
    title: "Cookie Policy",
    description: "How Elevate Spaces uses cookies and similar tracking technologies across the platform.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>COOKIE POLICY</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <h3>1. Use of Cookies</h3>
      <p>We use cookies and similar tracking technologies to:</p>
      <ul>
        <li>Maintain platform functionality</li>
        <li>Analyze usage</li>
        <li>Improve performance</li>
        <li>Prevent fraud</li>
      </ul>
      <h3>2. Third-Party Services</h3>
      <p>We may use third-party analytics services that deploy cookies.</p>
      <p>We do not control third-party tracking technologies.</p>
      <h3>3. Cookie Management</h3>
      <p>You may disable cookies through browser settings.</p>
      <p>Disabling cookies may limit functionality.</p>
    `,
  },
  {
    slug: "copyright-policy",
    title: "Copyright Policy",
    description: "DMCA and copyright reporting procedures for intellectual property complaints.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>COPYRIGHT POLICY (DMCA NOTICE)</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <h3>1. Copyright Compliance</h3>
      <p>Elevate Spaces respects intellectual property rights and expects users to do the same.</p>
      <h3>2. DMCA Notice Procedure</h3>
      <p>To submit a copyright infringement claim, provide:</p>
      <ul>
        <li>Identification of the copyrighted work</li>
        <li>Identification of allegedly infringing material</li>
        <li>Contact information</li>
        <li>Statement of good faith belief</li>
        <li>Statement under penalty of perjury</li>
        <li>Physical or electronic signature</li>
      </ul>
      <p>Send notices to:</p>
      <p><strong>elevatespacesai@gmail.com</strong></p>
      <h3>3. Repeat Infringers</h3>
      <p>We may suspend or terminate accounts of repeat infringers at our sole discretion.</p>
    `,
  },
  {
    slug: "disclaimer",
    title: "Disclaimer",
    description: "Important limitations and disclaimers regarding AI-generated outputs and platform use.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>DISCLAIMER</h2>
      <p><strong>Last Updated:</strong> March 3, 2026</p>
      <p>All AI-generated images and outputs are digital visualizations for illustrative purposes only.</p>
      <p>Elevate Spaces makes no representations or warranties regarding:</p>
      <ul>
        <li>Structural feasibility</li>
        <li>Engineering compliance</li>
        <li>MLS compliance</li>
        <li>Regulatory compliance</li>
        <li>Sale price or rental performance</li>
      </ul>
      <p>Users assume full responsibility for verifying compliance with applicable laws.</p>
    `,
  },
  {
    slug: "support",
    title: "Support",
    description: "How to contact Elevate Spaces for assistance, support, and legal inquiries.",
    contentHtml: `
      <h2>ELEVATE SPACES AI, LLC</h2>
      <h2>SUPPORT</h2>
      <p>For assistance or legal inquiries, contact:</p>
      <p><strong>elevatespacesai@gmail.com</strong></p>
      <p>Response times may vary.</p>
    `,
  },
];

function buildDefaultStore(): LegalDocumentsStore {
  const updatedAt = nowIso();
  return {
    documents: DEFAULT_LEGAL_DOCUMENTS.map((document) => ({
      ...document,
      updatedAt,
      updatedBy: null,
    })),
  };
}

async function writeStore(store: LegalDocumentsStore) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function readStore(): Promise<LegalDocumentsStore> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as LegalDocumentsStore;

    const mergedDocuments = DEFAULT_LEGAL_DOCUMENTS.map((defaultDocument) => {
      const existing = parsed.documents.find((doc) => doc.slug === defaultDocument.slug);
      if (existing) {
        return existing;
      }

      return {
        ...defaultDocument,
        updatedAt: nowIso(),
        updatedBy: null,
      };
    });

    const normalizedStore = { documents: mergedDocuments };

    if (mergedDocuments.length !== parsed.documents.length) {
      await writeStore(normalizedStore);
    }

    return normalizedStore;
  } catch {
    const defaultStore = buildDefaultStore();
    await writeStore(defaultStore);
    return defaultStore;
  }
}

export async function listLegalDocuments() {
  const store = await readStore();
  return store.documents;
}

export async function getLegalDocumentBySlug(slug: string) {
  const store = await readStore();
  return store.documents.find((document) => document.slug === slug) || null;
}

export async function updateLegalDocument(
  slug: string,
  input: { title?: string; description?: string; contentHtml?: string },
  updatedBy: string | null
) {
  const store = await readStore();
  const documentIndex = store.documents.findIndex((document) => document.slug === slug);

  if (documentIndex === -1) {
    throw new Error("Legal document not found");
  }

  const currentDocument = store.documents[documentIndex];
  const updatedDocument: LegalDocumentRecord = {
    ...currentDocument,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : currentDocument.title,
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : currentDocument.description,
    contentHtml:
      typeof input.contentHtml === "string" && input.contentHtml.trim()
        ? input.contentHtml
        : currentDocument.contentHtml,
    updatedAt: nowIso(),
    updatedBy,
  };

  store.documents[documentIndex] = updatedDocument;
  await writeStore(store);
  return updatedDocument;
}
