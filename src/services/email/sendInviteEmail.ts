// services/email/sendInviteEmail.ts
import { readFileSync } from "fs";
import path from "path";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { renderTemplate } from "./renderTemplate";

const ses = new SESClient({ region: process.env.AWS_REGION });

export async function sendInviteEmail({
    to,
    inviterName,
    tenantName,
    inviteLink,
}: {
    to: string;
    inviterName: string;
    tenantName: string;
    inviteLink: string;
}) {
    const templatePath = path.join(
        process.cwd(),
        "services",
        "email",
        "invite.html"
    );

    const rawHtml = readFileSync(templatePath, "utf8");

    const html = renderTemplate(rawHtml, {
        inviterName,
        tenantName,
        inviteLink,
    });

    await ses.send(
        new SendEmailCommand({
            Source: "fframess <noreply@fframess.com>",
            Destination: { ToAddresses: [to] },
            Message: {
                Subject: {
                    Data: `You’ve been invited to ${tenantName} on fframess`,
                },
                Body: {
                    Html: { Data: html },
                },
            },
        })
    );
}
