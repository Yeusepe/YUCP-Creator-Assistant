/**
 * Global custom emoji list for the Creator Assistant bot.
 * Use in embed text (titles, descriptions) or with discord.js setEmoji().
 *
 * - E.* - markdown strings for embed text (e.g. E.Assistant)
 * - Emoji.* - { id, name } for components (e.g. .setEmoji(Emoji.Bag))
 */

import type { ComponentEmojiResolvable } from 'discord.js';

/** Markdown strings for use in embed text (e.g. titles, descriptions). */
export const E = {
  Assistant: '<:Assistant:1478606847320784926>',
  Bag: '<:Bag:1478606849220677632>',
  Discord: '<:Discord:1478606849996623903>',
  Gumorad: '<:Gumorad:1478606851192000613>',
  Jinxxy: '<:Jinxxy:1478606852479647885>',
  Key: '<:Key:1478609887012585492>',
  KeyCloud: '<:KeyCloud:1478609887742263496>',
  Link: '<:Link:1478609888656756808>',
  Point: '<:Point:1478609889621184636>',
  PointDown: '<:PointDown:1478613865112666112>',
  Wrench: '<:Wrench:1478732159568318710>',
  Library: '<:Library:1478732160683872327>',
  World: '<:World:1478732161644363797>',
  CreditCard: '<:CreditCard:1478740002816135268>',
  ItchIo: '<:ItchIo:1480592072837693543>',
  LemonSqueezy: '<:LemonSqueezy:1480592075396349984>',
  Patreon: '<:Patreon:1480592076780474522>',
  Refresh: '<:Refresh:1478740004569223198>',
  ClapStars: '<:ClapStars:1478760445429944465>',
  GiftCard: '<:GiftCard:1478760446495293473>',
  PersonKey: '<:PersonKey:1478760448097521744>',
  ThumbsUp: '<:ThumbsUp:1478760449196687380>',
  Timer: '<:Timer:1478760450740195449>',
  Touch: '<:Touch:1478760451612344412>',
  VRC: '<:VRC:1480019585666257146>',
  Payhip: '<:Payhip:1480592074045919447>',
  X_: '<:X_:1478760454108090539>',
  Carrot: '<:Carrot:1478761064920387615>',
  Dance: '<:Dance:1478761065863970998>',
  Home: '<:Home:1478761067155951749>',
  Checkmark: '<:Checkmark:1478775474443518084>',
  Num0: '<:0_:1483581222457442304>',
  Num1: '<:1_:1483581224034373665>',
  Num2: '<:2_:1483581225837789264>',
  Num3: '<:3_:1483581226735501392>',
  Num4: '<:4_:1483581227628888205>',
  Num5: '<:5_:1483581228522405989>',
  Num6: '<:6_:1483581229529039062>',
  Num7: '<:7_:1483581231047377137>',
  Num8: '<:8_:1483581232280240258>',
  Num9: '<:9_:1483581233643524096>',
} as const;

/** Shape accepted by discord.js setEmoji() for custom emojis. */
const customEmoji = (id: string, name: string): ComponentEmojiResolvable => ({ id, name });

/** Emoji objects for discord.js components. Use with .setEmoji(Emoji.Bag), etc. */
export const Emoji = {
  Assistant: customEmoji('1478606847320784926', 'Assistant'),
  Bag: customEmoji('1478606849220677632', 'Bag'),
  Discord: customEmoji('1478606849996623903', 'Discord'),
  Gumorad: customEmoji('1478606851192000613', 'Gumorad'),
  Jinxxy: customEmoji('1478606852479647885', 'Jinxxy'),
  Key: customEmoji('1478609887012585492', 'Key'),
  KeyCloud: customEmoji('1478609887742263496', 'KeyCloud'),
  Link: customEmoji('1478609888656756808', 'Link'),
  Point: customEmoji('1478609889621184636', 'Point'),
  PointDown: customEmoji('1478613865112666112', 'PointDown'),
  Wrench: customEmoji('1478732159568318710', 'Wrench'),
  Library: customEmoji('1478732160683872327', 'Library'),
  World: customEmoji('1478732161644363797', 'World'),
  CreditCard: customEmoji('1478740002816135268', 'CreditCard'),
  ItchIo: customEmoji('1480592072837693543', 'ItchIo'),
  LemonSqueezy: customEmoji('1480592075396349984', 'LemonSqueezy'),
  Patreon: customEmoji('1480592076780474522', 'Patreon'),
  Refresh: customEmoji('1478740004569223198', 'Refresh'),
  ClapStars: customEmoji('1478760445429944465', 'ClapStars'),
  GiftCard: customEmoji('1478760446495293473', 'GiftCard'),
  PersonKey: customEmoji('1478760448097521744', 'PersonKey'),
  ThumbsUp: customEmoji('1478760449196687380', 'ThumbsUp'),
  Timer: customEmoji('1478760450740195449', 'Timer'),
  Touch: customEmoji('1478760451612344412', 'Touch'),
  VRC: customEmoji('1480019585666257146', 'VRC'),
  Payhip: customEmoji('1480592074045919447', 'Payhip'),
  X_: customEmoji('1478760454108090539', 'X_'),
  Carrot: customEmoji('1478761064920387615', 'Carrot'),
  Dance: customEmoji('1478761065863970998', 'Dance'),
  Home: customEmoji('1478761067155951749', 'Home'),
  Checkmark: customEmoji('1478775474443518084', 'Checkmark'),
  Num0: customEmoji('1483581222457442304', '0_'),
  Num1: customEmoji('1483581224034373665', '1_'),
  Num2: customEmoji('1483581225837789264', '2_'),
  Num3: customEmoji('1483581226735501392', '3_'),
  Num4: customEmoji('1483581227628888205', '4_'),
  Num5: customEmoji('1483581228522405989', '5_'),
  Num6: customEmoji('1483581229529039062', '6_'),
  Num7: customEmoji('1483581231047377137', '7_'),
  Num8: customEmoji('1483581232280240258', '8_'),
  Num9: customEmoji('1483581233643524096', '9_'),
} as const;

/** Emoji IDs for CDN URLs (embed thumbnails). Use with getEmojiCdnUrl(). */
export const EmojiIds = {
  Library: '1478732160683872327',
  Bag: '1478606849220677632',
  PersonKey: '1478740004569223198',
  Home: '1478761067155951749',
} as const;

/** Discord CDN URL for custom emoji - use with embed.setThumbnail(). */
export function getEmojiCdnUrl(emojiId: string): string {
  return `https://cdn.discordapp.com/emojis/${emojiId}.png`;
}
