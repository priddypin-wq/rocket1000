import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        background: "#0b0b14",
        color: "#fff",
        border: "22px solid #f8344b",
        borderRadius: "94px",
        fontWeight: 900,
      }}
    >
      <span style={{ fontSize: 170, lineHeight: 1 }}>R</span>
      <span style={{ fontSize: 76, color: "#ff536b", letterSpacing: "5px" }}>
        1000
      </span>
    </div>,
    size,
  );
}
