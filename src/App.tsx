
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

const POWER_ON_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef
]);

const POWER_OFF_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef
]);

// Native seven-color crossfade effect.
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

// Settings saving
interface AppSettings {
  mode: string;
  shiftMode: string;
  staticColor: string;
  customColors: string[];
  brightness: number;
  speed: number;
  audioSensitivity: number;
}

const STORAGE_KEY = "led-controller-settings";

const DEFAULT_SETTINGS: AppSettings = {
  mode: "static",
  shiftMode: "rainbow",
  staticColor: "#FFFFFF",
  customColors: ["#FF0000", "#00FF00", "#0000FF"],
  brightness: 100,
  speed: 100,
  audioSensitivity: 65
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

      audioSensitivity:
        typeof parsed.audioSensitivity === "number" &&
        Number.isFinite(parsed.audioSensitivity) &&
        parsed.audioSensitivity >= 1 &&
        parsed.audioSensitivity <= 100
          ? parsed.audioSensitivity
          : DEFAULT_SETTINGS.audioSensitivity,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
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
        Math.round(value).toString(16).padStart(2, "0")
      )
      .join("")
  ).toUpperCase();
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

// Wait between animation updates.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function App() {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Get settings from cache.
  const [initialSettings] = useState<AppSettings>(loadSettings);

  // Don't use on/off with cache.
  const [isLedOn, setIsLedOn] = useState(true);

  const [mode, setMode] = useState(initialSettings.mode);
  const [shiftMode, setShiftMode] = useState(initialSettings.shiftMode);
  const [speed, setSpeed] = useState(initialSettings.speed);
  const [staticColor, setStaticColor] = useState(initialSettings.staticColor);
  const [customColors, setCustomColors] = useState(initialSettings.customColors);
  const [brightness, setBrightness] = useState(initialSettings.brightness);
  const [audioSensitivity, setAudioSensitivity] = useState(
    initialSettings.audioSensitivity
  );

  // Audio input settings.
  const [audioInput, setAudioInput] = useState("default");
  const [audioDevices, setAudioDevices] = useState<AudioInputDevice[]>([]);
  const [audioActive, setAudioActive] = useState(false);
  const [audioError, setAudioError] = useState("");

  // Increment this when the app needs to refresh the LED controller.
  const [refreshVersion, setRefreshVersion] = useState(0);

  // Track the Bluetooth connection and dropdown.
  const characteristicRef = useRef<GattCharacteristic | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const shiftDropdownRef = useRef<HTMLDivElement | null>(null);

  const [shiftDropdownOpen, setShiftDropdownOpen] = useState(false);

  // Track audio processing resources.
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioFrameRef = useRef<number | null>(null);

  // Keep the latest sensitivity value available to the audio animation loop.
  const audioSensitivityRef = useRef(audioSensitivity);
  audioSensitivityRef.current = audioSensitivity;

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
        // Desktop audio requires the browser's screen-sharing picker.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        // The video track is only needed to obtain desktop audio.
        if (stream.getAudioTracks().length === 0) {
          throw new Error(
            "No audio was shared. Select a tab or screen and enable audio sharing."
          );
        }
      } else {
        // Capture the selected microphone or default audio input.
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

      // Refresh device labels after microphone permission is granted.
      await refreshAudioDevices();

      context = new AudioContext();
      audioContextRef.current = context;

      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();

      analyser.fftSize = 2048;

      // Reduce analyser smoothing so beats are detected more immediately.
      analyser.smoothingTimeConstant = 0.15;

      source.connect(analyser);

      audioSourceRef.current = source;

      const frequencyData = new Uint8Array(analyser.frequencyBinCount);

      // Track brightness smoothing and Bluetooth update frequency.
      let smoothedLevel = 0;
      let lastSentBrightness = 5;
      let lastSendTime = 0;
      let brightnessWritePending = false;

      // Analyze bass frequencies and translate them into LED brightness.
      const analyzeAudio = () => {
        if (
          !audioContextRef.current ||
          audioContextRef.current.state === "closed"
        ) {
          return;
        }

        analyser.getByteFrequencyData(frequencyData);

        const sampleRate = context!.sampleRate;
        const frequencyPerBin = sampleRate / analyser.fftSize;

        // Focus on the lower bass frequencies.
        const firstBassBin = Math.max(
          1,
          Math.floor(35 / frequencyPerBin)
        );

        const lastBassBin = Math.min(
          frequencyData.length - 1,
          Math.ceil(200 / frequencyPerBin)
        );

        let squaredTotal = 0;
        let peakLevel = 0;
        let count = 0;

        // Calculate RMS and peak energy across the bass range.
        for (let i = firstBassBin; i <= lastBassBin; i++) {
          const value = frequencyData[i];

          squaredTotal += value * value;
          peakLevel = Math.max(peakLevel, value);
          count++;
        }

        const bassRms =
          count > 0
            ? Math.sqrt(squaredTotal / count)
            : 0;

        // Combine average energy and individual bass peaks.
        const bassSignal =
          bassRms * 0.65 + peakLevel * 0.35;

        // Convert the sensitivity slider into a detection threshold.
        // Higher sensitivity means quieter bass can trigger a response.
        const sensitivity = audioSensitivityRef.current / 100;

        const threshold = 12 - sensitivity * 9;
        const signalRange = 65 - sensitivity * 43;

        const targetLevel = Math.max(
          0,
          Math.min(1, (bassSignal - threshold) / signalRange)
        );

        // Rise very quickly when a beat is detected.
        // Fade more gradually between beats.
        if (targetLevel > smoothedLevel) {
          smoothedLevel +=
            (targetLevel - smoothedLevel) * 0.90;
        } else {
          smoothedLevel +=
            (targetLevel - smoothedLevel) * 0.16;
        }

        // Keep a small amount of brightness between bass hits.
        const minimumBrightness = 5;
        const brightnessRange = 95;

        const nextBrightness = Math.round(
          minimumBrightness + smoothedLevel * brightnessRange
        );

        const now = performance.now();

        // Avoid queuing outdated brightness commands.
        // If a Bluetooth write is still pending, the next animation
        // frame will use the latest audio reading instead.
        if (
          !brightnessWritePending &&
          Math.abs(nextBrightness - lastSentBrightness) >= 1 &&
          now - lastSendTime >= 35
        ) {
          lastSentBrightness = nextBrightness;
          lastSendTime = now;
          brightnessWritePending = true;

          void sendBrightness(nextBrightness)
            .catch((error) => {
              console.error("Audio brightness update failed:", error);
            })
            .finally(() => {
              brightnessWritePending = false;
            });
        }

        audioFrameRef.current = requestAnimationFrame(analyzeAudio);
      };

      // Apply the selected color before beginning brightness updates.
      await sendColor(staticColor);
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

      // Initialize the LED controller.
      await writeCharacteristic(
        POWER_ON_COMMAND.buffer as ArrayBuffer
      );

      await wait(100);

      // Apply the selected static color.
      // Shifting and audio modes are initialized after connection updates.
      if (mode === "static") {
        await sendColor(staticColor);
      }

      // Apply the selected brightness.
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

  // Update the LED color when the selected audio color changes.
  useEffect(() => {
    if (
      !connected ||
      !characteristicRef.current ||
      mode !== "audio"
    ) {
      return;
    }

    void sendColor(staticColor).catch((error) => {
      console.error("Audio mode color update failed:", error);
    });
  }, [
    connected,
    mode,
    staticColor,
    sendColor,
    refreshVersion,
  ]);

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
        brightness,
        speed,
        audioSensitivity,
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
    brightness,
    speed,
    audioSensitivity,
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

        {/* Connected status */}
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

        {/* On/off */}
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

        {/* Connect/disconnect */}
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

            {/* Shift mode dropdown */}
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

            {/* Speed slider */}
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
                ? "Listening for bass and adjusting LED brightness."
                : audioInput === "desktop"
                  ? "Share a browser tab or screen and enable audio sharing when prompted."
                  : "Select an audio input and start listening to control LED brightness."}
            </p>

            {audioActive && (
              <p className="setting-description">
                Audio reactive mode is active.
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

          {/* Audio sensitivity slider */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">AUDIO RESPONSE</div>
                <h2>Sensitivity</h2>
              </div>

              <strong className="percent-value">
                {audioSensitivity}%
              </strong>
            </div>

            <input
              type="range"
              min="1"
              max="100"
              value={audioSensitivity}
              onChange={(event) =>
                setAudioSensitivity(Number(event.target.value))
              }
              disabled={!connected}
            />

            <p className="setting-description">
              Higher sensitivity makes the LEDs react to quieter sounds.
              Lower sensitivity focuses on stronger bass hits.
            </p>
          </section>

          {renderColorPanel(
            "Choose Your Color",
            staticColor,
            setStaticColor
          )}
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

          {/* Brightness slider */}
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
