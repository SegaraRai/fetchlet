import { component$ } from "@builder.io/qwik";
import { QwikCityProvider, RouterOutlet } from "@builder.io/qwik-city";
import { RouterHead } from "./components/router-head";
import "./global.css";

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <RouterHead />
    </head>
    <body lang="en">
      <RouterOutlet />
    </body>
  </QwikCityProvider>
));
