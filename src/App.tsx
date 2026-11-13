
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

interface GattServer {
  connected: boolean;
  connect(): Promise<{
    getPrimaryService(uuid: string): Promise<{
      getCharacteristic(uuid: string): Promise<GattCharacteristic>;
    }>;
  }>;
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

const POWER_ON_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef
]);

const POWER_OFF_COMMAND = new Uint8Array([
  0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef
]);

const PRESET_COLORS = [
  "#FF0000", // Red
  "#FF3300", // Orange
  "#FFFF00", // Yellow
  "#00FF00", // Green
  "#00FFFF", // Cyan
  "#0000FF", // Blue
  "#8000FF", // Purple
  "#FF13F0", // Pink
  "#FFFFFF", // White
];

// Settings saving
interface AppSettings {
  mode: string;
  staticColor: string;
  brightness: number;
  speed: number;
}

const STORAGE_KEY = "led-controller-settings";

const DEFAULT_SETTINGS: AppSettings = {
  mode: "static",
  staticColor: "#FFFFFF",
  brightness: 100,
  speed: 100
};

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(saved);

    return {
      mode: ["static", "shift", "audio"].includes(parsed.mode)
        ? parsed.mode
        : DEFAULT_SETTINGS.mode,

      staticColor:
        typeof parsed.staticColor === "string" &&
        /^#[0-9A-Fa-f]{6}$/.test(parsed.staticColor)
          ? parsed.staticColor
          : DEFAULT_SETTINGS.staticColor,

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
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function makeColorCommand(r: number, g: number, b: number) {
  return new Uint8Array([
    0x7e, 0x00, 0x05, 0x03,
    r, g, b, 0x00, 0xef,
  ]).buffer;
}

function makeBrightnessCommand(level: number) {
  const brightness = Math.max(0, Math.min(100, Math.round(level)));

  return new Uint8Array([
    0x7e, 0x00, 0x01,
    brightness, 0x00, 0x00, 0x00, 0x00, 0xef,
  ]).buffer;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");

  return [
    parseInt(value.substring(0, 2), 16),
    parseInt(value.substring(2, 4), 16),
    parseInt(value.substring(4, 6), 16),
  ];
}

function App() {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Get settings from cache
  const [initialSettings] = useState<AppSettings>(loadSettings);

  // Don't use on/off with cache
  const [isLedOn, setIsLedOn] = useState(true);

  const [mode, setMode] = useState(initialSettings.mode);

  // Initialize with initialSettings.shiftMode
  const [shiftMode, setShiftMode] = useState();

  const [speed, setSpeed] = useState(initialSettings.speed);

  const [staticColor, setStaticColor] = useState(initialSettings.staticColor);
  const [brightness, setBrightness] = useState(initialSettings.brightness);

  const characteristicRef = useRef<GattCharacteristic | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const busyRef = useRef(false);

  const writeCharacteristic = useCallback(async (data: ArrayBuffer) => {
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
  }, []);

  const turnLedOn = async () => {
    if (!characteristicRef.current) return;

    await writeCharacteristic(POWER_ON_COMMAND.buffer as ArrayBuffer);
    setIsLedOn(true);
  };

  const turnLedOff = async () => {
    if (!characteristicRef.current) return;

    await writeCharacteristic(POWER_OFF_COMMAND.buffer as ArrayBuffer);
    setIsLedOn(false);
  };

  const sendColor = useCallback(
    async (color: string) => {
      const [r, g, b] = hexToRgb(color);
      await writeCharacteristic(makeColorCommand(r, g, b));
    },
    [writeCharacteristic]
  );

  const sendBrightness = useCallback(
    async (level: number) => {
      await writeCharacteristic(makeBrightnessCommand(level));
    },
    [writeCharacteristic]
  );

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
        new Uint8Array([
          0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef,
        ]).buffer
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Apply the selected color and brightness.
      await sendColor(staticColor);
      await sendBrightness(brightness);

      setDeviceName(device.name || "ELK-BLEDOM");
      setConnected(true);
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

  const disconnectBluetooth = () => {
    deviceRef.current?.gatt?.disconnect();

    characteristicRef.current = null;
    deviceRef.current = null;

    setConnected(false);
    setDeviceName("");
  };

  // Apply color and brightness whenever their settings change.
  useEffect(() => {
    if (!connected || !characteristicRef.current) return;

    if (busyRef.current) return;

    busyRef.current = true;

    const updateLighting = async () => {
      try {
        if (mode === "static") {
          console.log("static");
          await sendColor(staticColor);
          await sendBrightness(brightness);
        }
        else if (mode === "shift") {
          console.log("shift");
        }
        else if (mode === "audio") {
          console.log("audio");
        }
      } catch (error) {
        console.error("LED update failed:", error);
      } finally {
        busyRef.current = false;
      }
    };

    void updateLighting();
  }, [connected, mode, staticColor, brightness, sendColor, sendBrightness]);

  // Save settings whenever they change.
  useEffect(() => {
    try {
      const settings: AppSettings = {
        mode,
        staticColor,
        brightness,
        speed,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error("Unable to save settings:", error);
    }
  }, [mode, staticColor, brightness, speed]);

  // Clean up the Bluetooth connection when the component unmounts.
  useEffect(() => {
    return () => {
      deviceRef.current?.gatt?.disconnect();
    };
  }, []);

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

      {/* Only show when mode is static */}
      {mode === "static" && (
        <>
          {/* Color selection panel */}
          <section className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">COLOR</div>
                <h2>Choose Your Color</h2>
              </div>
            </div>

            {/* Preset color selection */}
            <div className="color-grid">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  className={`color-button ${staticColor === color ? "selected" : ""}`}
                  style={{ backgroundColor: color }}
                  onClick={() => setStaticColor(color)}
                  disabled={!connected}
                  aria-label={`Select color ${color}`}
                  title={color}
                />
              ))}
            </div>

            {/* Preset color selection */}
            <h3>Custom:</h3>

            <div className="color-picker">
              <input
                className={`custom-color-input ${
                  PRESET_COLORS.includes(staticColor.toUpperCase()) ? "" : "selected"
                }`}
                type="color"
                value={staticColor}
                onChange={(e) => setStaticColor(e.target.value)}
                disabled={!connected}
              />

              <strong>{staticColor.toUpperCase()}</strong>
            </div>
          </section>
        </>
      )}

      {/* Only show when mode is shift */}
      {mode === "shift" && (
        <>
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
              onChange={(e) => setSpeed(Number(e.target.value))}
              disabled={!connected}
            />

            <p className="setting-description">
              Adjust the speed of your LED strip.
            </p>
          </section>
        </>
      )}

      {/* Only show when mode is static or shift */}
      {(mode === "static" || mode === "shift") && (
        <>
          {/* Brightness slider panel */}
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
              onChange={(e) => setBrightness(Number(e.target.value))}
              disabled={!connected}
            />

            <p className="setting-description">
              Adjust the brightness of your LED strip.
            </p>
          </section>
        </>
      )}

      <footer>
        <p>&copy; {new Date().getFullYear()} Cole Lentini. All rights reserved.</p>
      </footer>
    </main>
  );
}

export default App;
