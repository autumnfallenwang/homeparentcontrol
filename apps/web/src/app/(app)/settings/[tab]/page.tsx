"use client";

import { notFound, useParams } from "next/navigation";
import { AppearanceSettings } from "../../../../components/settings/appearance.js";
import { ChildrenAndDevices } from "../../../../components/settings/children-devices.js";
import { UsageDataSettings } from "../../../../components/settings/usage-data.js";
import { isSettingsTab } from "../../../../components/shell/nav.js";

/**
 * `/settings/[tab]` — one route per tab, as in homework, so a tab can be
 * linked to directly ("go to Settings › Children & devices"). Bare
 * `/settings` redirects to the first tab (next.config.mjs).
 */
export default function SettingsTabPage() {
  const { tab } = useParams<{ tab: string }>();
  if (!isSettingsTab(tab)) notFound();
  if (tab === "children") return <ChildrenAndDevices />;
  if (tab === "usage") return <UsageDataSettings />;
  return <AppearanceSettings />;
}
