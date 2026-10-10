import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string; latest_reach: number | null };
type DeliveryCountRow = { creator_id: string; n: number };

// latest_reach soma as views da métrica mais recente de cada conta do criador
// (maior captured_at, empate pelo maior id), lida pelo índice metrics_latest_by_account.
const CREATORS_WITH_REACH = `
  SELECT
    creator.id,
    creator.name,
    creator.niches_json,
    (
      SELECT SUM((
        SELECT metric.views
        FROM metrics AS metric
        WHERE metric.account_id = account.id
        ORDER BY metric.captured_at DESC, metric.id DESC
        LIMIT 1
      ))
      FROM social_accounts AS account
      WHERE account.creator_id = creator.id
    ) AS latest_reach
  FROM creators AS creator`;

const DELIVERIES_SINCE = `
  SELECT creator_id, COUNT(*) AS n
  FROM deliveries
  WHERE delivered_at >= ? AND creator_id IN (SELECT value FROM json_each(?))
  GROUP BY creator_id`;

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = await all<CreatorRow>(db, CREATORS_WITH_REACH);
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: creator.latest_reach ?? 0,
      deliveries_90d: 0,
    });
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);

  // deliveries_90d não entra na ordenação: só é contado para quem está na página.
  if (page.length > 0) {
    const deliveries = await all<DeliveryCountRow>(
      db,
      DELIVERIES_SINCE,
      deliveriesSince(),
      JSON.stringify(page.map((creator) => creator.id)),
    );
    const deliveriesByCreator = new Map(deliveries.map((row) => [row.creator_id, Number(row.n)]));
    for (const creator of page) creator.deliveries_90d = deliveriesByCreator.get(creator.id) ?? 0;
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
