// The browser entry: it makes the server-rendered counter interactive.
import "./styles.css";

const counter = document.querySelector<HTMLButtonElement>("[data-counter]");
if (counter) {
  let clicks = 0;
  counter.addEventListener("click", () => {
    clicks += 1;
    counter.textContent = `Clicks ${clicks}`;
  });
  counter.dataset.hydrated = "true";
}
