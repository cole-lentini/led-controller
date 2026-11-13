import { useCallback, useEffect, useRef, useState } from "react";
import "./styles/App.css";

const SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000fff3-0000-1000-8000-00805f9b34fb";

interface GattCharacteristic {
  properties: {
    write: boolean;
    writeWithoutResponse: boolean;
  };
  writeValue(value: ArrayBuffer): Promise<void>;
  writeValueWithResponse?(value: ArrayBuffer): Promise<void>;
  writeValueWithoutResponse?(value: ArrayBuffer): Promise<void>;
}

interface GattConnection {
  getPrimaryService(uuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<GattCharacteristic>;
  }>;
}

interface GattServer {
  connected: boolean;
  connect(): Promise<GattConnection>;
  disconnect(): void;
}

interface BluetoothDevice {
  name?: string;
  gatt?: GattServer;
  addEventListener(
    event: "gattserverdisconnected",
    callback: () => void
  ): void;
}

interface BluetoothAPI {
  requestDevice(options: {
    filters: { namePrefix: string }[];
    optionalServices: string[];
  }): Promise<BluetoothDevice>;
}

interface AudioInputDevice {
  deviceId: string;
  label: string;
}

interface AudioDiagnostics {
  bassRaw: number;
  midRaw: number;
  trebleRaw: number;
  bassNormalized: number;
  midNormalized: number;
  trebleNormalized: number;
  overall: number;
  color: string;
}

interface AppSettings {
  mode: string;
  shiftMode: string;
  staticColor: string;
  customColors: string[];
  audioColors: string[];
  brightness: number;
  speed: number;
  bassSensitivity: number;
  midSensitivity: number;
  trebleSensitivity: number;
  overallSensitivity: number;
}

const POWER_ON_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef
]);

const POWER_OFF_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef
]);

const RAINBOW_EFFECT_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x03, 0x8a, 0x03, 0x00, 0x00, 0x00, 0xef
]);

const PRESET_COLORS = [
  "#FF0000",
  "#FF3300",
  "#FFFF00",
  "#00FF00",
  "#00FFFF",
  "#0000FF",
  "#8000FF",
  "#FF13F0",
  "#FFFFFF",
];

const STORAGE_KEY = "led-controller-settings";

const DEFAULT_SETTINGS: AppSettings = {
  mode: "static",
  shiftMode: "rainbow",
  staticColor: "#FFFFFF",
  customColors: ["#FF0000", "#00FF00", "#0000FF"],
  audioColors: ["#FF3300", "#00FF66", "#3366FF"],
  brightness: 100,
  speed: 100,
  bassSensitivity: 50,
  midSensitivity: 50,
  trebleSensitivity: 50,
  overallSensitivity: 50,
};

// Load saved settings from local storage.
function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(saved);

    const validCustomColors =
      Array.isArray(parsed.customColors) &&
      parsed.customColors.length === 3 &&
      parsed.customColors.every(
        (color: unknown) =>
          typeof color === "string" && /^#[0-9A-Fa-f]{6}$/.test(color)
      );

    const validAudioColors =
      Array.isArray(parsed.audioColors) &&
      parsed.audioColors.length === 3 &&
      parsed.audioColors.every(
        (color: unknown) =>
          typeof color === "string" && /^#[0-9A-Fa-f]{6}$/.test(color)
      );

    const getSensitivity = (value: unknown, fallback: number) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100
        ? value
        : fallback;

    return {
      mode: ["static", "shift", "audio"].includes(parsed.mode)
        ? parsed.mode
        : DEFAULT_SETTINGS.mode,

      shiftMode: ["rainbow", "random", "custom"].includes(parsed.shiftMode)
        ? parsed.shiftMode
        : DEFAULT_SETTINGS.shiftMode,

      staticColor:
        typeof parsed.staticColor === "string" &&
        /^#[0-9A-Fa-f]{6}$/.test(parsed.staticColor)
          ? parsed.staticColor
          : DEFAULT_SETTINGS.staticColor,

      customColors: validCustomColors
        ? parsed.customColors
        : DEFAULT_SETTINGS.customColors,

      audioColors: validAudioColors
        ? parsed.audioColors
        : DEFAULT_SETTINGS.audioColors,

      brightness:
        typeof parsed.brightness === "number" &&
        Number.isFinite(parsed.brightness) &&
        parsed.brightness >= 0 &&
        parsed.brightness <= 100
          ? parsed.brightness
          : DEFAULT_SETTINGS.brightness,

      speed:
        typeof parsed.speed === "number" &&
        Number.isFinite(parsed.speed) &&
        parsed.speed >= 0 &&
        parsed.speed <= 100
          ? parsed.speed
          : DEFAULT_SETTINGS.speed,

      bassSensitivity: getSensitivity(
        parsed.bassSensitivity,
        DEFAULT_SETTINGS.bassSensitivity
      ),

      midSensitivity: getSensitivity(
        parsed.midSensitivity,
        DEFAULT_SETTINGS.midSensitivity
      ),

      trebleSensitivity: getSensitivity(
        parsed.trebleSensitivity,
        DEFAULT_SETTINGS.trebleSensitivity
      ),

      overallSensitivity: getSensitivity(
        parsed.overallSensitivity,
        DEFAULT_SETTINGS.overallSensitivity
      ),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Create a nonlinear sensitivity multiplier.
// 0 = 0.1x, 50 = 1x, 100 = 10x.
function getSensitivityMultiplier(sensitivity: number): number {
  return 0.1 * Math.pow(100, sensitivity / 100);
}

// Create the Bluetooth command for a color.
function makeColorCommand(r: number, g: number, b: number) {
  return new Uint8Array([
    0x7e, 0x00, 0x05, 0x03,
    r, g, b, 0x00, 0xef,
  ]).buffer;
}

// Create the Bluetooth command for brightness.
function makeBrightnessCommand(level: number) {
  const brightness = Math.max(0, Math.min(100, Math.round(level)));

  return new Uint8Array([
    0x7e, 0x00, 0x01,
    brightness, 0x00, 0x00, 0x00, 0x00, 0xef,
  ]).buffer;
}

// Create the Bluetooth command for native effect speed.
function makeEffectSpeedCommand(level: number) {
  const speed = Math.max(0, Math.min(100, Math.round(level)));

  return new Uint8Array([
    0x7e, 0x00, 0x02,
    speed, 0x00, 0x00, 0x00, 0x00, 0xef,
  ]).buffer;
}

// Convert a hexadecimal color into RGB values.
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");

  return [
    parseInt(value.substring(0, 2), 16),
    parseInt(value.substring(2, 4), 16),
    parseInt(value.substring(4, 6), 16),
  ];
}

// Convert RGB values back into a hexadecimal color.
function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((value) =>
        Math.max(0, Math.min(255, Math.round(value)))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  ).toUpperCase();
}

// Blend selected frequency colors using normalized, weighted contributions.
// A power above 1 gives louder frequency bands more influence over the result.
function mixFrequencyColors(
  colors: string[],
  intensities: number[],
  dominancePower = 2
): string {
  const weights = intensities.map((intensity) =>
    Math.pow(clamp(intensity, 0, 1), dominancePower)
  );

  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  if (totalWeight <= 0.0001) {
    return "#000000";
  }

  let red = 0;
  let green = 0;
  let blue = 0;

  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = hexToRgb(colors[i]);
    const weight = weights[i] / totalWeight;

    red += r * weight;
    green += g * weight;
    blue += b * weight;
  }

  return rgbToHex(red, green, blue);
}

// Interpolate between two colors.
function interpolateColor(
  startColor: string,
  endColor: string,
  progress: number
): string {
  const [startR, startG, startB] = hexToRgb(startColor);
  const [endR, endG, endB] = hexToRgb(endColor);

  return rgbToHex(
    startR + (endR - startR) * progress,
    startG + (endG - startG) * progress,
    startB + (endB - startB) * progress
  );
}

// Keep a value within a specified range.
function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Wait between animation updates.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function App() {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [initialSettings] = useState<AppSettings>(loadSettings);

  const [isLedOn, setIsLedOn] = useState(true);

  const [mode, setMode] = useState(initialSettings.mode);
  const [shiftMode, setShiftMode] = useState(initialSettings.shiftMode);
  const [speed, setSpeed] = useState(initialSettings.speed);
  const [staticColor, setStaticColor] = useState(initialSettings.staticColor);
  const [customColors, setCustomColors] = useState(initialSettings.customColors);
  const [audioColors, setAudioColors] = useState(initialSettings.audioColors);
  const [brightness, setBrightness] = useState(initialSettings.brightness);

  // Independent audio sensitivity controls.
  const [bassSensitivity, setBassSensitivity] = useState(
    initialSettings.bassSensitivity
  );

  const [midSensitivity, setMidSensitivity] = useState(
    initialSettings.midSensitivity
  );

  const [trebleSensitivity, setTrebleSensitivity] = useState(
    initialSettings.trebleSensitivity
  );

  const [overallSensitivity, setOverallSensitivity] = useState(
    initialSettings.overallSensitivity
  );

  // Audio input settings.
  const [audioInput, setAudioInput] = useState("default");
  const [audioDevices, setAudioDevices] = useState<AudioInputDevice[]>([]);
  const [audioActive, setAudioActive] = useState(false);
  const [audioError, setAudioError] = useState("");

  const [audioDiagnostics, setAudioDiagnostics] =
    useState<AudioDiagnostics>({
      bassRaw: 0,
      midRaw: 0,
      trebleRaw: 0,
      bassNormalized: 0,
      midNormalized: 0,
      trebleNormalized: 0,
      overall: 0,
      color: "#000000",
    });

  const [refreshVersion, setRefreshVersion] = useState(0);

  const characteristicRef = useRef<GattCharacteristic | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const shiftDropdownRef = useRef<HTMLDivElement | null>(null);

  const [shiftDropdownOpen, setShiftDropdownOpen] = useState(false);

  // Track audio processing resources.
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioFrameRef = useRef<number | null>(null);

  // Keep the latest sensitivities available to the audio animation loop.
  const bassSensitivityRef = useRef(bassSensitivity);
  const midSensitivityRef = useRef(midSensitivity);
  const trebleSensitivityRef = useRef(trebleSensitivity);
  const overallSensitivityRef = useRef(overallSensitivity);
  const audioColorsRef = useRef(audioColors);

  bassSensitivityRef.current = bassSensitivity;
  midSensitivityRef.current = midSensitivity;
  trebleSensitivityRef.current = trebleSensitivity;
  overallSensitivityRef.current = overallSensitivity;
  audioColorsRef.current = audioColors;

  // Queue Bluetooth writes so GATT operations never overlap.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const writeCharacteristic = useCallback((data: ArrayBuffer) => {
    const write = async () => {
      const characteristic = characteristicRef.current;

      if (!characteristic) return;

      if (
        characteristic.properties.writeWithoutResponse &&
        characteristic.writeValueWithoutResponse
      ) {
        await characteristic.writeValueWithoutResponse(data);
      } else if (characteristic.writeValueWithResponse) {
        await characteristic.writeValueWithResponse(data);
      } else {
        await characteristic.writeValue(data);
      }
    };

    const queuedWrite = writeQueueRef.current.then(write);

    writeQueueRef.current = queuedWrite.catch(() => {});

    return queuedWrite;
  }, []);

  // Turn the LED strip on.
  const turnLedOn = async () => {
    if (!characteristicRef.current) return;

    await writeCharacteristic(POWER_ON_COMMAND.buffer as ArrayBuffer);
    setIsLedOn(true);
  };

  // Turn the LED strip off.
  const turnLedOff = async () => {
    if (!characteristicRef.current) return;

    await writeCharacteristic(POWER_OFF_COMMAND.buffer as ArrayBuffer);
    setIsLedOn(false);
  };

  // Send a color to the LED strip.
  const sendColor = useCallback(
    async (color: string) => {
      const [r, g, b] = hexToRgb(color);
      await writeCharacteristic(makeColorCommand(r, g, b));
    },
    [writeCharacteristic]
  );

  // Send a brightness level to the LED strip.
  const sendBrightness = useCallback(
    async (level: number) => {
      await writeCharacteristic(makeBrightnessCommand(level));
    },
    [writeCharacteristic]
  );

  // Start the controller's native rainbow effect.
  const startRainbowEffect = useCallback(async () => {
    await writeCharacteristic(
      RAINBOW_EFFECT_COMMAND.buffer as ArrayBuffer
    );
  }, [writeCharacteristic]);

  // Update the speed of a native effect.
  const sendEffectSpeed = useCallback(
    async (level: number) => {
      await writeCharacteristic(makeEffectSpeedCommand(level));
    },
    [writeCharacteristic]
  );

  // Stop audio capture and processing.
  const stopAudioProcessing = useCallback(() => {
    if (audioFrameRef.current !== null) {
      cancelAnimationFrame(audioFrameRef.current);
      audioFrameRef.current = null;
    }

    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;

    audioStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    audioStreamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;

    if (context && context.state !== "closed") {
      void context.close().catch((error) => {
        console.error("Unable to close audio context:", error);
      });
    }

    setAudioActive(false);
  }, []);

  // Get available microphone and audio input devices.
  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const inputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }));

      setAudioDevices(inputs);
    } catch (error) {
      console.error("Unable to enumerate audio devices:", error);
      setAudioError("Unable to retrieve audio input devices.");
    }
  }, []);

  // Start listening to the selected audio input.
  const startAudioProcessing = async () => {
    if (!connected || !characteristicRef.current) {
      setAudioError("Connect to your LED controller first.");
      return;
    }

    stopAudioProcessing();
    setAudioError("");

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;

    try {
      if (audioInput === "desktop") {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        if (stream.getAudioTracks().length === 0) {
          throw new Error(
            "No audio was shared. Select a tab or screen and enable audio sharing."
          );
        }
      } else {
        const audioConstraints: MediaTrackConstraints =
          audioInput === "default"
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              }
            : {
                deviceId: { exact: audioInput },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              };

        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      }

      audioStreamRef.current = stream;

      await refreshAudioDevices();

      context = new AudioContext();
      audioContextRef.current = context;

      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();

      analyser.fftSize = 2048;

      // Let each animation frame read the latest frequency data directly.
      // Smoothing is handled separately below so we can control attack/release.
      analyser.smoothingTimeConstant = 0;

      source.connect(analyser);

      audioSourceRef.current = source;

      const frequencyData = new Uint8Array(analyser.frequencyBinCount);

      let smoothedBass = 0;
      let smoothedMid = 0;
      let smoothedTreble = 0;
      let smoothedBrightness = 0;

      // Smooth the final RGB output independently from the frequency levels.
      let smoothedColorRed = 0;
      let smoothedColorGreen = 0;
      let smoothedColorBlue = 0;

      let lastSentBrightness = 5;
      let lastSentColor = "#000000";

      let desiredBrightness = 5;
      let desiredColor = "#000000";

      let lastSendTime = 0;
      let lastDiagnosticUpdate = 0;
      let outputWritePending = false;
      let previousFrameTime = performance.now();

      // Measure the strongest frequency bins instead of averaging
      // every bin in the frequency range.
      const getBandEnergy = (
        firstBin: number,
        lastBin: number
      ) => {
        const values: number[] = [];

        for (let i = firstBin; i <= lastBin; i++) {
          values.push(frequencyData[i]);
        }

        if (values.length === 0) return 0;

        values.sort((a, b) => b - a);

        // Average only the strongest 12% of bins.
        // This prevents quieter frequencies from diluting transients.
        const strongestBinCount = Math.max(
          1,
          Math.ceil(values.length * 0.12)
        );

        const strongestTotal = values
          .slice(0, strongestBinCount)
          .reduce((total, value) => total + value, 0);

        const strongestAverage =
          strongestTotal / strongestBinCount;

        const peakLevel = values[0];

        // Give the strongest bins most of the influence,
        // while still retaining the absolute peak.
        return strongestAverage * 0.7 + peakLevel * 0.3;
      };

      // Convert raw energy into a normalized 0–1 value.
      const normalizeBand = (
        signal: number,
        sensitivity: number
      ) => {
        const multiplier = getSensitivityMultiplier(sensitivity);
        const adjustedSignal = signal * multiplier;

        return clamp(
          (adjustedSignal - 4) / 100,
          0,
          1
        );
      };

      // Smooth a signal using time-based attack and release.
      // This keeps the response consistent at different frame rates.
      const smoothBand = (
        current: number,
        target: number,
        deltaTime: number,
        attackTime: number,
        releaseTime: number
      ) => {
        const timeConstant =
          target > current ? attackTime : releaseTime;

        const factor =
          1 - Math.exp(-deltaTime / timeConstant);

        return current + (target - current) * factor;
      };

      // Send the newest desired LED state without dropping updates.
      // If audio changes while a Bluetooth write is pending,
      // the next iteration sends the latest values.
      const flushAudioOutput = async () => {
        if (outputWritePending) return;

        outputWritePending = true;

        try {
          while (characteristicRef.current) {
            const [lastR, lastG, lastB] = hexToRgb(lastSentColor);
            const [nextR, nextG, nextB] = hexToRgb(desiredColor);

            const colorDifference = Math.max(
              Math.abs(nextR - lastR),
              Math.abs(nextG - lastG),
              Math.abs(nextB - lastB)
            );

            const brightnessDifference = Math.abs(
              desiredBrightness - lastSentBrightness
            );

            const shouldSendColor = colorDifference >= 3;
            const shouldSendBrightness = brightnessDifference >= 2;

            if (!shouldSendColor && !shouldSendBrightness) {
              break;
            }

            // Capture the latest target values for this write cycle.
            const colorToSend = desiredColor;
            const brightnessToSend = desiredBrightness;

            if (shouldSendColor) {
              await sendColor(colorToSend);
              lastSentColor = colorToSend;
            }

            if (shouldSendBrightness) {
              await sendBrightness(brightnessToSend);
              lastSentBrightness = brightnessToSend;
            }

            lastSendTime = performance.now();

            // Give the controller a short interval before sending
            // another update, while retaining the newest target.
            await wait(50);
          }
        } catch (error) {
          console.error("Audio visualizer update failed:", error);
        } finally {
          outputWritePending = false;
        }
      };

      // Analyze audio and translate the frequency distribution into color.
      const analyzeAudio = () => {
        if (
          !audioContextRef.current ||
          audioContextRef.current.state === "closed"
        ) {
          return;
        }

        analyser.getByteFrequencyData(frequencyData);

        const now = performance.now();

        const deltaTime = clamp(
          now - previousFrameTime,
          1,
          100
        );

        previousFrameTime = now;

        const frequencyPerBin =
          context!.sampleRate / analyser.fftSize;

        const bassStart = 35;
        const bassEnd = 250;

        const midStart = 250;
        const midEnd = 2000;

        const trebleStart = 2000;
        const trebleEnd = 10000;

        const bassFirstBin = Math.max(
          1,
          Math.floor(bassStart / frequencyPerBin)
        );

        const bassLastBin = Math.min(
          frequencyData.length - 1,
          Math.ceil(bassEnd / frequencyPerBin)
        );

        const midFirstBin = Math.max(
          1,
          Math.floor(midStart / frequencyPerBin)
        );

        const midLastBin = Math.min(
          frequencyData.length - 1,
          Math.ceil(midEnd / frequencyPerBin)
        );

        const trebleFirstBin = Math.max(
          1,
          Math.floor(trebleStart / frequencyPerBin)
        );

        const trebleLastBin = Math.min(
          frequencyData.length - 1,
          Math.ceil(trebleEnd / frequencyPerBin)
        );

        // Measure each frequency range independently.
        const bassSignal = getBandEnergy(
          bassFirstBin,
          bassLastBin
        );

        const midSignal = getBandEnergy(
          midFirstBin,
          midLastBin
        );

        const trebleSignal = getBandEnergy(
          trebleFirstBin,
          trebleLastBin
        );

        // Each frequency has its own sensitivity.
        const targetBass = normalizeBand(
          bassSignal,
          bassSensitivityRef.current
        );

        const targetMid = normalizeBand(
          midSignal,
          midSensitivityRef.current
        );

        const targetTreble = normalizeBand(
          trebleSignal,
          trebleSensitivityRef.current
        );

        // Fast attack and slower release for each color channel.
        smoothedBass = smoothBand(
          smoothedBass,
          targetBass,
          deltaTime,
          28,
          170
        );

        smoothedMid = smoothBand(
          smoothedMid,
          targetMid,
          deltaTime,
          28,
          170
        );

        smoothedTreble = smoothBand(
          smoothedTreble,
          targetTreble,
          deltaTime,
          28,
          170
        );

        // Overall brightness should react to strong individual bands.
        // The maximum prevents one loud band from being diluted by
        // two quieter bands. The weighted component adds stability.
        const weightedSignal =
          bassSignal * 0.5 +
          midSignal * 0.3 +
          trebleSignal * 0.2;

        const strongestSignal = Math.max(
          bassSignal,
          midSignal,
          trebleSignal
        );

        const combinedRawSignal =
          strongestSignal * 0.75 +
          weightedSignal * 0.25;

        const targetOverall = normalizeBand(
          combinedRawSignal,
          overallSensitivityRef.current
        );

        // Brightness responds quickly to increases and fades more slowly.
        smoothedBrightness = smoothBand(
          smoothedBrightness,
          targetOverall,
          deltaTime,
          35,
          220
        );

        const nextBrightness = Math.round(
          5 + smoothedBrightness * 95
        );

        // Give stronger frequency bands more influence over the color.
        // Squaring the intensities reduces muddy blends when one band is louder.
        const targetColor = mixFrequencyColors(
          audioColorsRef.current,
          [smoothedBass, smoothedMid, smoothedTreble],
          2
        );

        const [targetRed, targetGreen, targetBlue] = hexToRgb(targetColor);

        // Smooth the final color so changes flow naturally between hues.
        smoothedColorRed = smoothBand(
          smoothedColorRed,
          targetRed,
          deltaTime,
          75,
          110
        );

        smoothedColorGreen = smoothBand(
          smoothedColorGreen,
          targetGreen,
          deltaTime,
          75,
          110
        );

        smoothedColorBlue = smoothBand(
          smoothedColorBlue,
          targetBlue,
          deltaTime,
          75,
          110
        );

        const nextColor = rgbToHex(
          smoothedColorRed,
          smoothedColorGreen,
          smoothedColorBlue
        );

        // Always update the desired output, even when a write is pending.
        desiredColor = nextColor;
        desiredBrightness = nextBrightness;

        // Update diagnostic readings 10 times per second.
        if (now - lastDiagnosticUpdate >= 100) {
          setAudioDiagnostics({
            bassRaw: Number(bassSignal.toFixed(1)),
            midRaw: Number(midSignal.toFixed(1)),
            trebleRaw: Number(trebleSignal.toFixed(1)),
            bassNormalized: Number((smoothedBass * 100).toFixed(1)),
            midNormalized: Number((smoothedMid * 100).toFixed(1)),
            trebleNormalized: Number((smoothedTreble * 100).toFixed(1)),
            overall: Number((smoothedBrightness * 100).toFixed(1)),
            color: nextColor,
          });

          lastDiagnosticUpdate = now;
        }

        // Start an output update when the minimum interval has elapsed.
        // If a previous update is still running, it will pick up the
        // latest desired values before it finishes.
        if (
          !outputWritePending &&
          now - lastSendTime >= 50
        ) {
          void flushAudioOutput();
        }

        audioFrameRef.current = requestAnimationFrame(analyzeAudio);
      };

      await sendColor("#000000");
      await sendBrightness(5);

      audioFrameRef.current = requestAnimationFrame(analyzeAudio);

      // Stop processing if the user ends desktop sharing.
      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          stopAudioProcessing();
        });
      });

      setAudioActive(true);
    } catch (error) {
      console.error("Audio initialization failed:", error);

      stream?.getTracks().forEach((track) => track.stop());

      if (context && context.state !== "closed") {
        await context.close().catch(() => {});
      }

      audioStreamRef.current = null;
      audioContextRef.current = null;
      audioSourceRef.current = null;

      setAudioActive(false);

      setAudioError(
        error instanceof Error
          ? error.message
          : "Unable to start audio processing."
      );
    }
  };

  // Update one of the three custom shift colors.
  const updateCustomColor = (index: number, color: string) => {
    setCustomColors((previousColors) =>
      previousColors.map((previousColor, i) =>
        i === index ? color : previousColor
      )
    );
  };

  // Connect to the Bluetooth LED strip.
  const connectBluetooth = async () => {
    const bluetooth = (
      navigator as Navigator & { bluetooth?: BluetoothAPI }
    ).bluetooth;

    if (!bluetooth) {
      alert("Web Bluetooth is unavailable. Please use Chrome or Edge.");
      return;
    }

    try {
      setConnecting(true);

      const device = await bluetooth.requestDevice({
        filters: [{ namePrefix: "ELK-BLEDOM" }],
        optionalServices: [SERVICE_UUID],
      });

      deviceRef.current = device;

      if (!device.gatt) {
        throw new Error("This device does not support GATT.");
      }

      const handleDisconnect = () => {
        characteristicRef.current = null;
        setConnected(false);
        setDeviceName("");
        stopAudioProcessing();
      };

      device.addEventListener(
        "gattserverdisconnected",
        handleDisconnect
      );

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(
        CHARACTERISTIC_UUID
      );

      characteristicRef.current = characteristic;

      await writeCharacteristic(
        POWER_ON_COMMAND.buffer as ArrayBuffer
      );

      await wait(100);

      if (mode === "static") {
        await sendColor(staticColor);
      }

      await sendBrightness(brightness);

      setDeviceName(device.name || "ELK-BLEDOM");
      setConnected(true);
      setIsLedOn(true);
    } catch (error) {
      console.error("Bluetooth connection failed:", error);

      characteristicRef.current = null;
      deviceRef.current?.gatt?.disconnect();
      deviceRef.current = null;

      alert(
        error instanceof Error
          ? error.message
          : "Unable to connect to the LED controller."
      );
    } finally {
      setConnecting(false);
    }
  };

  // Disconnect from the Bluetooth LED strip.
  const disconnectBluetooth = () => {
    stopAudioProcessing();

    deviceRef.current?.gatt?.disconnect();

    characteristicRef.current = null;
    deviceRef.current = null;

    setConnected(false);
    setDeviceName("");
  };

  // Refresh the Bluetooth connection when returning to the browser tab.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== "visible") return;

      const device = deviceRef.current;

      if (!device?.gatt) return;

      try {
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const characteristic = await service.getCharacteristic(
          CHARACTERISTIC_UUID
        );

        characteristicRef.current = characteristic;

        if (isLedOn) {
          await writeCharacteristic(
            POWER_ON_COMMAND.buffer as ArrayBuffer
          );
        }

        setDeviceName(device.name || "ELK-BLEDOM");
        setConnected(true);

        if (audioContextRef.current?.state === "suspended") {
          await audioContextRef.current.resume();
        }

        setRefreshVersion((previous) => previous + 1);
      } catch (error) {
        console.error("Bluetooth refresh failed:", error);

        characteristicRef.current = null;
        setConnected(false);
        setDeviceName("");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
    };
  }, [isLedOn, writeCharacteristic]);

  // Load available audio input devices when entering audio mode.
  useEffect(() => {
    if (mode !== "audio") return;

    void refreshAudioDevices();
  }, [mode, refreshAudioDevices]);

  // Stop audio processing when leaving audio mode.
  useEffect(() => {
    if (mode !== "audio") {
      stopAudioProcessing();
    }
  }, [mode, stopAudioProcessing]);

  // Apply the selected static color and brightness.
  useEffect(() => {
    if (!connected || !characteristicRef.current || mode !== "static") return;

    const updateLighting = async () => {
      try {
        await sendColor(staticColor);
        await sendBrightness(brightness);
      } catch (error) {
        console.error("LED update failed:", error);
      }
    };

    void updateLighting();
  }, [
    connected,
    mode,
    staticColor,
    brightness,
    sendColor,
    sendBrightness,
    refreshVersion,
  ]);

  // Keep brightness updated while a shift effect is running.
  useEffect(() => {
    if (!connected || !characteristicRef.current || mode !== "shift") return;

    void sendBrightness(brightness).catch((error) => {
      console.error("Brightness update failed:", error);
    });
  }, [
    connected,
    mode,
    brightness,
    sendBrightness,
    refreshVersion,
  ]);

  // Run the native rainbow effect directly on the LED controller.
  useEffect(() => {
    if (
      !connected ||
      !characteristicRef.current ||
      mode !== "shift" ||
      shiftMode !== "rainbow"
    ) {
      return;
    }

    void startRainbowEffect().catch((error) => {
      console.error("Native rainbow effect failed:", error);
    });
  }, [
    connected,
    mode,
    shiftMode,
    startRainbowEffect,
    refreshVersion,
  ]);

  // Run the JavaScript-based Random and Custom shifting effects.
  useEffect(() => {
    if (
      !connected ||
      !characteristicRef.current ||
      mode !== "shift" ||
      shiftMode === "rainbow"
    ) {
      return;
    }

    let cancelled = false;

    const runShiftEffect = async () => {
      const colors =
        shiftMode === "custom"
          ? customColors
          : PRESET_COLORS;

      if (colors.length === 0) return;

      let currentColor =
        shiftMode === "random"
          ? colors[Math.floor(Math.random() * colors.length)]
          : colors[0];

      let colorIndex = 1;

      try {
        await sendColor(currentColor);

        while (!cancelled) {
          let nextColor: string;

          if (shiftMode === "random") {
            do {
              nextColor = colors[
                Math.floor(Math.random() * colors.length)
              ];
            } while (nextColor === currentColor && colors.length > 1);
          } else {
            nextColor = colors[colorIndex % colors.length];
            colorIndex++;
          }

          const transitionDuration = 6000 - speed * 50;
          const updateInterval = 5;
          const steps = Math.max(
            1,
            Math.ceil(transitionDuration / updateInterval)
          );

          for (let step = 1; step <= steps; step++) {
            if (cancelled) return;

            const progress = step / steps;
            const color = interpolateColor(
              currentColor,
              nextColor,
              progress
            );

            await sendColor(color);
            await wait(updateInterval);
          }

          currentColor = nextColor;
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Shift effect failed:", error);
        }
      }
    };

    void runShiftEffect();

    return () => {
      cancelled = true;
    };
  }, [
    connected,
    mode,
    shiftMode,
    customColors,
    speed,
    sendColor,
    refreshVersion,
  ]);

  // Update native rainbow speed without restarting the effect.
  useEffect(() => {
    if (
      !connected ||
      !characteristicRef.current ||
      mode !== "shift" ||
      shiftMode !== "rainbow"
    ) {
      return;
    }

    void sendEffectSpeed(speed).catch((error) => {
      console.error("Native effect speed update failed:", error);
    });
  }, [
    connected,
    mode,
    shiftMode,
    speed,
    sendEffectSpeed,
    refreshVersion,
  ]);

  // Save settings whenever they change.
  useEffect(() => {
    try {
      const settings: AppSettings = {
        mode,
        shiftMode,
        staticColor,
        customColors,
        audioColors,
        brightness,
        speed,
        bassSensitivity,
        midSensitivity,
        trebleSensitivity,
        overallSensitivity,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error("Unable to save settings:", error);
    }
  }, [
    mode,
    shiftMode,
    staticColor,
    customColors,
    audioColors,
    brightness,
    speed,
    bassSensitivity,
    midSensitivity,
    trebleSensitivity,
    overallSensitivity,
  ]);

  // Close the shift dropdown when clicking outside of it.
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        shiftDropdownRef.current &&
        !shiftDropdownRef.current.contains(event.target as Node)
      ) {
        setShiftDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  // Clean up Bluetooth and audio connections when the component unmounts.
  useEffect(() => {
    return () => {
      if (audioFrameRef.current !== null) {
        cancelAnimationFrame(audioFrameRef.current);
      }

      audioSourceRef.current?.disconnect();

      audioStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        void audioContextRef.current.close();
      }

      deviceRef.current?.gatt?.disconnect();
    };
  }, []);

  // Render a color selection panel.
  const renderColorPanel = (
    title: string,
    color: string,
    onChange: (color: string) => void
  ) => (
    <section className="panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow">COLOR</div>
          <h2>{title}</h2>
        </div>
      </div>

      <div className="color-grid">
        {PRESET_COLORS.map((presetColor) => (
          <button
            key={presetColor}
            className={`color-button ${
              color.toUpperCase() === presetColor ? "selected" : ""
            }`}
            style={{ backgroundColor: presetColor }}
            onClick={() => onChange(presetColor)}
            disabled={!connected}
            aria-label={`Select color ${presetColor}`}
            title={presetColor}
          />
        ))}
      </div>

      <h3>Custom:</h3>

      <div className="color-picker">
        <input
          className={`custom-color-input ${
            PRESET_COLORS.includes(color.toUpperCase()) ? "" : "selected"
          }`}
          type="color"
          value={color}
          onChange={(event) => onChange(event.target.value)}
          disabled={!connected}
        />

        <strong>{color.toUpperCase()}</strong>
      </div>
    </section>
  );

  // Render an individual audio sensitivity slider.
  const renderSensitivitySlider = (
    title: string,
    description: string,
    value: number,
    onChange: (value: number) => void
  ) => (
    <div className="sensitivity-control">
      <div className="section-heading">
        <div>
          <h3>{title}</h3>
        </div>

        <strong className="percent-value">{value}%</strong>
      </div>

      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={!connected}
      />

      <p className="setting-description">{description}</p>
    </div>
  );

  return (
    <main className="app">
      <header className="header">
        <div>
          <div className="eyebrow">LIGHTING CONTROL</div>
          <h1>
            LED Controller<span>.</span>
          </h1>
          <p className="subtitle">For the apartment bedroom.</p>
        </div>

        <div className={`connection ${connected ? "online" : ""}`}>
          <span className="status-dot" />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      {/* Connect/disconnect card */}
      <section className="connection-card panel">
        <div className="device-icon">◈</div>

        <div className="device-info">
          <strong>{connected ? deviceName : "LED Controller"}</strong>
          <span>
            {connected
              ? "Bluetooth LED Strip"
              : "Connect to your Bluetooth LED strip"}
          </span>
        </div>

        <button
          className="button"
          style={{
            backgroundColor: isLedOn ? "#dc3545" : "#198754",
            color: "white"
          }}
          onClick={isLedOn ? turnLedOff : turnLedOn}
          disabled={!connected}
        >
          {isLedOn ? "Turn off" : "Turn on"}
        </button>

        {connected ? (
          <button
            className="button secondary"
            onClick={disconnectBluetooth}
          >
            Disconnect
          </button>
        ) : (
          <button
            className="button primary"
            onClick={connectBluetooth}
            disabled={connecting}
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        )}
      </section>

      {/* Mode panel */}
      <section className="panel">
        <div className="section-heading">
          <div>
            <div className="eyebrow">LIGHTING</div>
            <h2>Select Mode</h2>
          </div>
        </div>

        <div className="mode-grid">
          <button
            className={`mode-card ${mode === "static" ? "selected" : ""}`}
            onClick={() => setMode("static")}
          >
            <span className="mode-icon">◉</span>
            <strong>Static Color</strong>
            <span>Choose your own color</span>
          </button>

          <button
            className={`mode-card ${mode === "shift" ? "selected" : ""}`}
            onClick={() => setMode("shift")}
          >
            <span className="mode-icon">☼</span>
            <strong>Shifting</strong>
            <span>Constantly changing color</span>
          </button>

          <button
            className={`mode-card ${mode === "audio" ? "selected" : ""}`}
            onClick={() => setMode("audio")}
          >
            <span className="mode-icon">♫</span>
            <strong>Audio Reactive</strong>
            <span>Colors respond to sound</span>
          </button>
        </div>
      </section>

      {/* Static color controls */}
      {mode === "static" &&
        renderColorPanel(
          "Choose Your Color",
          staticColor,
          setStaticColor
        )}

      {/* Shift mode controls */}
      {mode === "shift" && (
        <>
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">TYPE</div>
                <h2>Choose Shift Mode</h2>
              </div>
            </div>

            <div className="shift-setting">
              <div className="shift-dropdown" ref={shiftDropdownRef}>
                <button
                  type="button"
                  className="dropdown"
                  onClick={() => setShiftDropdownOpen((open) => !open)}
                  disabled={!connected}
                  aria-expanded={shiftDropdownOpen}
                  aria-haspopup="listbox"
                >
                  <span>
                    {shiftMode === "rainbow"
                      ? "Rainbow Colors"
                      : shiftMode === "random"
                        ? "Random Colors"
                        : "Custom Colors"}
                  </span>
                  <span className={`dropdown-arrow ${shiftDropdownOpen ? "open" : ""}`}>
                    ▼
                  </span>
                </button>

                {shiftDropdownOpen && (
                  <div className="dropdown-menu" role="listbox">
                    <button
                      type="button"
                      className={shiftMode === "rainbow" ? "selected" : ""}
                      onClick={() => {
                        setShiftMode("rainbow");
                        setShiftDropdownOpen(false);
                      }}
                      role="option"
                      aria-selected={shiftMode === "rainbow"}
                    >
                      Rainbow Colors
                    </button>

                    <button
                      type="button"
                      className={shiftMode === "random" ? "selected" : ""}
                      onClick={() => {
                        setShiftMode("random");
                        setShiftDropdownOpen(false);
                      }}
                      role="option"
                      aria-selected={shiftMode === "random"}
                    >
                      Random Colors
                    </button>

                    <button
                      type="button"
                      className={shiftMode === "custom" ? "selected" : ""}
                      onClick={() => {
                        setShiftMode("custom");
                        setShiftDropdownOpen(false);
                      }}
                      role="option"
                      aria-selected={shiftMode === "custom"}
                    >
                      Custom Colors
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Custom shift colors */}
          {shiftMode === "custom" && (
            <>
              {renderColorPanel(
                "Color 1",
                customColors[0],
                (color) => updateCustomColor(0, color)
              )}

              {renderColorPanel(
                "Color 2",
                customColors[1],
                (color) => updateCustomColor(1, color)
              )}

              {renderColorPanel(
                "Color 3",
                customColors[2],
                (color) => updateCustomColor(2, color)
              )}
            </>
          )}

          {/* Speed slider panel */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">OUTPUT</div>
                <h2>Speed</h2>
              </div>

              <strong className="percent-value">{speed}%</strong>
            </div>

            <input
              type="range"
              min="0"
              max="100"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              disabled={!connected}
            />

            <p className="setting-description">
              Adjust the speed of your LED strip.
            </p>
          </section>
        </>
      )}

      {/* Audio reactive controls */}
      {mode === "audio" && (
        <>
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">INPUT</div>
                <h2>Audio Source</h2>
              </div>
            </div>

            <div className="shift-setting">
              <select
                className="dropdown"
                value={audioInput}
                onChange={(event) => {
                  stopAudioProcessing();
                  setAudioInput(event.target.value);
                  setAudioError("");
                }}
                disabled={!connected || audioActive}
              >
                <option value="default">Default Microphone</option>

                {audioDevices.map((device) => (
                  <option
                    key={device.deviceId}
                    value={device.deviceId}
                  >
                    {device.label}
                  </option>
                ))}

                <option value="desktop">
                  Desktop Audio (Share Tab or Screen)
                </option>
              </select>
            </div>

            <div style={{ marginTop: "16px" }}>
              {!audioActive ? (
                <button
                  className="button primary"
                  onClick={startAudioProcessing}
                  disabled={!connected}
                >
                  Start Listening
                </button>
              ) : (
                <button
                  className="button secondary"
                  onClick={stopAudioProcessing}
                >
                  Stop Listening
                </button>
              )}
            </div>

            <p className="setting-description">
              {audioActive
                ? "Listening to bass, midrange, and treble. Brightness and color respond to the music."
                : audioInput === "desktop"
                  ? "Share a browser tab or screen and enable audio sharing when prompted."
                  : "Select an audio input and start listening to control LED brightness and color."}
            </p>

            {audioActive && (
              <p className="setting-description">
                Fluid frequency color blending is active.
              </p>
            )}

            {audioError && (
              <p
                className="setting-description"
                style={{ color: "#dc3545" }}
              >
                {audioError}
              </p>
            )}
          </section>

          {/* Individual audio sensitivity controls */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">AUDIO RESPONSE</div>
                <h2>Frequency Sensitivity</h2>
              </div>
            </div>

            <p className="setting-description">
              Adjust how strongly each frequency range contributes to its selected
              color. Louder frequency bands have more influence over the final
              blended color.
            </p>

            {renderSensitivitySlider(
              "Bass",
              "Controls how strongly low frequencies influence the final color.",
              bassSensitivity,
              setBassSensitivity
            )}

            {renderSensitivitySlider(
              "Midrange",
              "Controls how strongly vocals and mid-frequency sounds influence the final color.",
              midSensitivity,
              setMidSensitivity
            )}

            {renderSensitivitySlider(
              "Treble",
              "Controls how strongly high frequencies influence the final color.",
              trebleSensitivity,
              setTrebleSensitivity
            )}
          </section>

          {/* Overall brightness sensitivity */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">BRIGHTNESS RESPONSE</div>
                <h2>Overall Sensitivity</h2>
              </div>

              <strong className="percent-value">
                {overallSensitivity}%
              </strong>
            </div>

            <input
              type="range"
              min="0"
              max="100"
              value={overallSensitivity}
              onChange={(event) =>
                setOverallSensitivity(Number(event.target.value))
              }
              disabled={!connected}
            />

            <p className="setting-description">
              Controls how strongly the combined audio signal affects
              LED brightness. This does not change the individual color
              channel sensitivities.
            </p>
          </section>

          {/* Individual frequency colors */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">COLOR MIXING</div>
                <h2>Frequency Colors</h2>
              </div>
            </div>

            <p className="setting-description">
              Choose a color for each frequency range. The colors blend together
              based on the audio being detected.
            </p>

            {renderColorPanel(
              "Bass",
              audioColors[0],
              (color) =>
                setAudioColors((previous) =>
                  previous.map((previousColor, index) =>
                    index === 0 ? color : previousColor
                  )
                )
            )}

            {renderColorPanel(
              "Midrange",
              audioColors[1],
              (color) =>
                setAudioColors((previous) =>
                  previous.map((previousColor, index) =>
                    index === 1 ? color : previousColor
                  )
                )
            )}

            {renderColorPanel(
              "Treble",
              audioColors[2],
              (color) =>
                setAudioColors((previous) =>
                  previous.map((previousColor, index) =>
                    index === 2 ? color : previousColor
                  )
                )
            )}
          </section>

          {/* Live audio diagnostics */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">DEBUGGING</div>
                <h2>Live Audio Diagnostics</h2>
              </div>

              <strong
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "8px",
                  backgroundColor: audioDiagnostics.color,
                  border: "1px solid rgba(128,128,128,0.4)",
                }}
              />
            </div>

            {(
              [
                ["Bass", audioDiagnostics.bassNormalized],
                ["Midrange", audioDiagnostics.midNormalized],
                ["Treble", audioDiagnostics.trebleNormalized],
                ["Overall", audioDiagnostics.overall],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div key={label} style={{ marginBottom: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "6px",
                  }}
                >
                  <strong>{label}</strong>
                  <span>{value.toFixed(1)}%</span>
                </div>

                <div
                  style={{
                    width: "100%",
                    height: "10px",
                    background: "rgba(128,128,128,0.2)",
                    borderRadius: "10px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${clamp(value, 0, 100)}%`,
                      height: "100%",
                      background: "#3a86d4",
                      borderRadius: "10px",
                      transition: "width 80ms linear",
                    }}
                  />
                </div>
              </div>
            ))}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "8px",
                marginTop: "20px",
              }}
            >
              {[
                ["Bass Raw", audioDiagnostics.bassRaw],
                ["Mid Raw", audioDiagnostics.midRaw],
                ["Treble Raw", audioDiagnostics.trebleRaw],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    padding: "10px",
                    background: "rgba(128,128,128,0.1)",
                    borderRadius: "8px",
                    textAlign: "center",
                    minWidth: 0,
                  }}
                >
                  <div style={{ fontSize: "12px", opacity: 0.7 }}>
                    {label}
                  </div>
                  <strong>{Number(value).toFixed(1)}</strong>
                </div>
              ))}
            </div>

            <p className="setting-description" style={{ marginTop: "16px" }}>
              Output RGB: {audioDiagnostics.color}
            </p>
          </section>
        </>
      )}

      {/* Brightness slider panel */}
      {(mode === "static" || mode === "shift") && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <div className="eyebrow">OUTPUT</div>
              <h2>Brightness</h2>
            </div>

            <strong className="percent-value">{brightness}%</strong>
          </div>

          <input
            type="range"
            min="0"
            max="100"
            value={brightness}
            onChange={(event) => setBrightness(Number(event.target.value))}
            disabled={!connected}
          />

          <p className="setting-description">
            Adjust the brightness of your LED strip.
          </p>
        </section>
      )}

      <footer>
        <p>© {new Date().getFullYear()} Cole Lentini. All rights reserved.</p>
      </footer>
    </main>
  );
}

export default App;