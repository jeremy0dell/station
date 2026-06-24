export const WEATHER_LOADING_EMOJI = "⏳";
export const WEATHER_ERROR_EMOJI = "🫥";

export function weatherEmoji(weatherCode: number, isDay: boolean): string {
  if (weatherCode === 0) {
    return isDay ? "☀️" : "🌙";
  }
  if ([1, 2].includes(weatherCode)) {
    return "🌤️";
  }
  if (weatherCode === 3) {
    return "☁️";
  }
  if ([45, 48].includes(weatherCode)) {
    return "🌫️";
  }
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(weatherCode)) {
    return [95, 96, 99].includes(weatherCode) ? "⛈️" : "🌧️";
  }
  if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) {
    return "🌨️";
  }
  return "🌡️";
}
