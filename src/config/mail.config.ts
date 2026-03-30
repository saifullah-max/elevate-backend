import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
dotenv.config();

// SendGrid HTTP API Configuration (use environment variables)
const sendgridApiKeyFromEnv = process.env.SENDGRID_API_KEY;
const fallbackSmtpPass = process.env.SMTP_PASS;

const SENDGRID_API_KEY =
    sendgridApiKeyFromEnv ||
    (fallbackSmtpPass && fallbackSmtpPass.startsWith("SG.")
        ? fallbackSmtpPass
        : undefined);

if (!SENDGRID_API_KEY) {
    throw new Error(
        "SendGrid API key is missing or invalid. Set SENDGRID_API_KEY to a valid SendGrid key (starts with SG.)."
    );
}

sgMail.setApiKey(SENDGRID_API_KEY);

// Email properties interface
export interface EmailProps {
    from: string;
    senderName: string;
    to: string;
    subject: string;
    text: string;
    html?: string; // optional HTML content
    replyTo?: string;
    senderEmail?: string;
}

// Send email function with spam prevention
export const sendEmail = async ({
    from,
    senderName,
    to,
    subject,
    text,
    html,
    replyTo,
    senderEmail,
}: EmailProps) => {
    // SendGrid requires verified sender email
    const verifiedSender = process.env.SENDGRID_VERIFIED_SENDER || "saifullahahmed380@gmail.com";
    
    const msg = {
        to,
        from: {
            email: verifiedSender,
            name: senderName || "Elevated Spaces",
        },
        replyTo: replyTo || from || verifiedSender,
        subject,
        text,
        html,
        // Anti-spam headers
        headers: {
            'X-Entity-Ref-ID': `invite-${Date.now()}`,
        },
        // Email categories for tracking
        categories: ['team-invitation'],
        // Custom arguments
        customArgs: {
            invite_type: 'team_member',
            sender: from,
        },
        // Tracking settings to avoid spam triggers
        trackingSettings: {
            clickTracking: {
                enable: false,
            },
            openTracking: {
                enable: false,
            },
        },
    };

    try {
        const [response] = await sgMail.send(msg);
        console.log("✅ Email sent successfully:", {
            messageId: response.headers["x-message-id"],
            to,
            statusCode: response.statusCode,
        });
        return response;
    } catch (err: any) {
        console.error("❌ SendGrid error:", {
            message: err.message,
            code: err.code,
            statusCode: err.response?.statusCode,
            response: err.response?.body,
        });
        throw err;
    }
};

// const { MailtrapClient } = require("mailtrap");

// const MAILTRAP_TOKEN = process.env.MAILTRAP_TOKEN;

// const client = new MailtrapClient({
//     token: MAILTRAP_TOKEN,
// });

// interface emailProps {
//     from: string;
//     senderName: string;
//     to: string;
//     subject: string;
//     text: string;
//     category?: string
// }

// export const sendEmail = ({
//     from,
//     senderName,
//     to,
//     subject,
//     text,
//     category,
// }: emailProps) => {
//     const sender = {
//         email: from,
//         name: senderName,
//     };

//     const recipients = [{ email: to }];

//     return client.send({
//         from: sender,
//         to: recipients,
//         subject,
//         text,
//         category,
//     });
// };



// const sender = {
//     email: "hello@elevatespacesai.com",
//     name: "Mailtrap Test",
// };
// const recipients = [
//     {
//         email: "saifullahahmed380@gmail.com",
//     }
// ];

// client
//     .send({
//         from: sender,
//         to: recipients,
//         subject: "You are awesome!",
//         text: "Congrats for sending test email with Mailtrap!",
//         category: "Integration Test",
//     })
//     .then(console.log, console.error);