import { useId } from "react";

export default function DeadpoolAvatar({
  className = "",
}: {
  className?: string;
}) {
  const id = useId();
  return (
    <svg
      className={className}
      viewBox="0 0 200 200"
      role="img"
      aria-label="Deadpool avatar"
    >
      <defs>
        <radialGradient id={`${id}-back`}>
          <stop stopColor="#20374a" />
          <stop offset="1" stopColor="#080c18" />
        </radialGradient>
        <linearGradient id={`${id}-mask`} x1="0" x2="1" y2=".6">
          <stop stopColor="#8d0d21" />
          <stop offset=".42" stopColor="#e33246" />
          <stop offset=".7" stopColor="#aa152a" />
          <stop offset="1" stopColor="#570b19" />
        </linearGradient>
        <linearGradient id={`${id}-suit`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#c8233b" />
          <stop offset="1" stopColor="#580c1d" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="100" cy="100" r="91" />
        </clipPath>
      </defs>
      <circle cx="100" cy="100" r="97" fill="#ff344b" opacity=".12" />
      <circle
        cx="100"
        cy="100"
        r="93"
        fill={`url(#${id}-back)`}
        stroke="#f3354c"
        strokeWidth="2.5"
      />
      <circle
        cx="100"
        cy="100"
        r="89"
        fill="none"
        stroke="#41c6f3"
        strokeOpacity=".28"
      />
      <g clipPath={`url(#${id}-clip)`}>
        <path
          d="M20 35 150 194M180 35 50 194"
          stroke="#020509"
          strokeWidth="12"
        />
        <path
          d="M20 35 150 194M180 35 50 194"
          stroke="#667580"
          strokeWidth="5"
        />
        <path d="m22 37 26 32m130-32-26 32" stroke="#171b22" strokeWidth="10" />
        <path
          d="m23 39 6-5m0 13 6-5m0 13 6-5m0 13 6-5m130-19-6-5m0 13-6-5m0 13-6-5m0 13-6-5"
          stroke="#9da5ae"
          strokeWidth="2"
        />
        <path
          d="M10 200c9-34 31-51 62-57h56c31 6 53 23 62 57"
          fill={`url(#${id}-suit)`}
        />
        <path d="m43 155 19-8 27 53H69Zm114 0-19-8-27 53h20Z" fill="#12131b" />
        <path
          d="M76 132v22l24 26 24-26v-22"
          fill="#721020"
          stroke="#1d1019"
          strokeWidth="2"
        />
        <path
          d="M100 31c28 0 43 21 43 52l-4 35c-2 19-22 39-39 39s-37-20-39-39l-4-35c0-31 15-52 43-52Z"
          fill={`url(#${id}-mask)`}
          stroke="#350b17"
          strokeWidth="2"
        />
        <path
          d="M100 34v119M68 49c7 15 7 33 5 55m59-55c-7 15-7 33-5 55"
          fill="none"
          stroke="#5e0b1b"
          strokeWidth="1.5"
          opacity=".75"
        />
        <path
          d="M68 58c10-5 22 5 23 23l-1 29c-7 14-15 20-23 19-9-19-10-48 1-71Zm64 0c-10-5-22 5-23 23l1 29c7 14 15 20 23 19 9-19 10-48-1-71Z"
          fill="#11151e"
          stroke="#310a16"
          strokeWidth="2"
        />
        <path
          d="m66 87 22 8c-7 7-17 7-20 3Zm68-2-22 10c7 6 16 6 20 1Z"
          fill="#f3f8fc"
        />
        <path
          d="m68 86 19 7m45-9-19 9"
          stroke="#cedde8"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="m98 92-4 25h12m-24 15c10 5 26 5 36-1"
          fill="none"
          stroke="#770d20"
          strokeWidth="2"
          opacity=".7"
        />
        <path
          d="m67 113 9 7m57-7-9 7M78 140l8 4m36-4-8 4"
          fill="none"
          stroke="#ed4f61"
          strokeWidth="1"
          opacity=".5"
        />
        <path
          d="M66 51c7-9 18-14 29-15"
          fill="none"
          stroke="#fa6c78"
          strokeWidth="2"
          opacity=".6"
        />
        <path d="m73 169 9 9m45-9-9 9" stroke="#9fa7b2" strokeWidth="4" />
        <circle
          cx="100"
          cy="187"
          r="13"
          fill="#1d1420"
          stroke="#f04251"
          strokeWidth="2"
        />
        <path
          d="M100 177v20m-8-15 5 3-3 4m14-7-5 3 3 4"
          fill="none"
          stroke="#e3dbe3"
          strokeWidth="2"
        />
      </g>
      <path
        d="M30 47a91 91 0 0 1 137-8"
        fill="none"
        stroke="#ff7480"
        strokeWidth="2"
        strokeLinecap="round"
        opacity=".65"
      />
    </svg>
  );
}
