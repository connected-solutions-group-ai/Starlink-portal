'use strict';
/**
 * Weather for the install day — Open-Meteo (free, no API key).
 * Geocodes the site (city) then pulls the daily forecast and flags roof-work risk
 * (high wind, precip, or cold). Mirrors the client-side check so the dev team can
 * run it server-side (e.g. to gate scheduling or trigger reschedule prompts).
 */
const WMO = (c) => c <= 1 ? 'Clear' : c <= 3 ? 'Partly cloudy' : c <= 48 ? 'Fog'
  : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Rain showers'
  : c <= 86 ? 'Snow showers' : 'Thunderstorm';

async function forecast(address, date) {
  if (!address || !date) throw new Error('address and date required');
  const city = (address.split(',')[1] || address.split(',')[0] || address).trim();
  const g = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city)).then((r) => r.json());
  const loc = g && g.results && g.results[0];
  if (!loc) return { error: `Could not locate "${city}"` };
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,precipitation_sum'
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&start_date=${date}&end_date=${date}`;
  const w = await fetch(u).then((r) => r.json());
  const d = w && w.daily;
  if (!d || !d.time || !d.time.length) return { error: 'No forecast for that date' };
  const res = {
    date, place: loc.name + (loc.admin1 ? ', ' + loc.admin1 : ''), lat: loc.latitude, lng: loc.longitude,
    code: d.weather_code[0], desc: WMO(d.weather_code[0]),
    tmax: Math.round(d.temperature_2m_max[0]), tmin: Math.round(d.temperature_2m_min[0]),
    pop: d.precipitation_probability_max[0], wind: Math.round(d.wind_speed_10m_max[0]), precip: d.precipitation_sum[0],
  };
  const risks = [];
  if (res.wind >= 25) risks.push(`high wind ${res.wind} mph`);
  if (res.pop >= 60) risks.push(`${res.pop}% precip chance`);
  if (res.precip >= 0.2) risks.push(`${res.precip}" precip`);
  if (res.tmax <= 20) risks.push(`cold ${res.tmax}°F`);
  res.risk = risks.length > 0; res.risks = risks;
  return res;
}

module.exports = { forecast };
