import qwikCityPlan from "@qwik-city-plan";
import { manifest } from "@qwik-client-manifest";
import { createQwikCity } from "fetchlet/qwik-city/middleware";

import render from "./entry.ssr";

export default createQwikCity({ render, qwikCityPlan, manifest });
