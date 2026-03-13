/**
 * Verification email when a collaborator's Jinxxy API key is manually added.
 */

import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';

const JINXXY_SETTINGS_URL = 'https://creators.jinxxy.com/settings/api';

export interface CollabKeyAddedEmailProps {
  collaboratorDisplayName: string;
  serverName: string;
  addedAt: string;
  to: string;
  connectionId: string;
}

export function CollabKeyAddedEmail({
  collaboratorDisplayName,
  serverName,
  addedAt,
}: CollabKeyAddedEmailProps) {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body className="bg-gray-100 font-sans">
          <Container className="mx-auto my-0 max-w-[600px] rounded-lg bg-white p-8 shadow-sm">
            <Section className="mb-6">
              <Text className="m-0 text-2xl font-bold text-gray-900">Creator Assistant</Text>
            </Section>

            <Section className="mb-6">
              <Text className="m-0 mb-4 text-base leading-6 text-gray-700">
                Hello {collaboratorDisplayName},
              </Text>
              <Text className="m-0 mb-4 text-base leading-6 text-gray-700">
                Your Jinxxy API key was added to a Discord server for license verification.
              </Text>
              <Text className="m-0 mb-4 text-base leading-6 text-gray-700">
                <strong>Server:</strong> {serverName}
                <br />
                <strong>Added at:</strong> {addedAt}
              </Text>
            </Section>

            <Section className="mb-6 rounded-lg bg-amber-50 p-4">
              <Text className="m-0 mb-2 text-sm font-semibold text-amber-800">
                If this wasn&apos;t you
              </Text>
              <Text className="m-0 text-sm leading-5 text-amber-900">
                Revoke your API key in Jinxxy to stop this server from verifying licenses with your
                store.
              </Text>
            </Section>

            <Section className="mb-6">
              <Button
                href={JINXXY_SETTINGS_URL}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
              >
                Revoke API key in Jinxxy
              </Button>
            </Section>

            <Hr className="my-6 border-gray-200" />

            <Section>
              <Text className="m-0 text-xs text-gray-500">
                Creator Assistant – Jinxxy license verification
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
