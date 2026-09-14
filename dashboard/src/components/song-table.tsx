"use client";
import Link from "next/link";
import {
  tableFeatures,
  useTable,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowUpRight, Music2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Status } from "./shared";
import type { Song } from "@/lib/model";
import { stamp } from "@/lib/model";
const features = tableFeatures({});
const columns: ColumnDef<typeof features, Song>[] = [
  {
    id: "song",
    header: "Song",
    cell: ({ row }) => (
      <Link
        prefetch={false}
        href={"/songs/" + row.original.id}
        className="song-link"
      >
        <span className="song-art">
          <Music2 size={18} />
        </span>
        <span>
          <strong>{row.original.title}</strong>
          <small>{row.original.artist}</small>
        </span>
      </Link>
    ),
  },
  {
    accessorKey: "language",
    header: "Language",
    cell: ({ row }) => (
      <span className="uppercase">{row.original.language}</span>
    ),
  },
  { accessorKey: "line_count", header: "Lines" },
  {
    id: "status",
    header: "Translation",
    cell: ({ row }) => (
      <Status value={row.original.translation_id ? "ready" : "missing"} />
    ),
  },
  {
    id: "saved",
    header: "Saved",
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">
        {stamp(row.original.translated_at ?? row.original.created_at)}
      </span>
    ),
  },
  {
    id: "open",
    header: "",
    cell: ({ row }) => (
      <Link
        prefetch={false}
        href={"/songs/" + row.original.id}
        aria-label={"Inspect " + row.original.title}
      >
        <ArrowUpRight size={17} />
      </Link>
    ),
  },
];
export function SongTable({ rows }: { rows: Song[] }) {
  const table = useTable({
    features,
    data: rows,
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((g) => (
          <TableRow key={g.id}>
            {g.headers.map((h) => (
              <TableHead key={h.id}>
                {h.isPlaceholder
                  ? null
                  : flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getAllCells().map((c) => (
              <TableCell key={c.id}>
                {flexRender(c.column.columnDef.cell, c.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
