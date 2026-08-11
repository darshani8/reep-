'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import SearchRounded from '@mui/icons-material/SearchRounded';
import {
  DataGrid,
  GridToolbarContainer,
  GridToolbarExport,
  type GridColDef,
  type GridRowParams,
} from '@mui/x-data-grid';

/**
 * One grid for the whole product.
 *
 * The wireframes draw plain tables, but a mentor with 12 mentees and a director
 * with 46 students need to sort, filter and export — so every table is this
 * grid. Search and the quick filters sit in one row above it, which is the only
 * place a filter is allowed to live.
 */

export type QuickFilter = {
  /// Shown on the toggle button.
  label: string;
  /// Rows to keep when this filter is active.
  test: (row: Record<string, unknown>) => boolean;
};

export function ReepGrid<R extends { id: string }>({
  rows,
  columns,
  searchPlaceholder = 'Search…',
  searchKeys,
  quickFilters,
  onRowHref,
  pageSize = 10,
  height,
  exportFileName,
  emptyLabel = 'Nothing to show.',
}: {
  rows: R[];
  columns: GridColDef[];
  searchPlaceholder?: string;
  /// Fields the search box looks at. Omit to disable search.
  searchKeys?: (keyof R)[];
  quickFilters?: QuickFilter[];
  /// Makes rows clickable — return the destination for a row.
  onRowHref?: (row: R) => string;
  pageSize?: number;
  height?: number;
  exportFileName?: string;
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [filterIndex, setFilterIndex] = useState<number | null>(null);

  const visible = useMemo(() => {
    let out = rows;

    if (query.trim() && searchKeys?.length) {
      const needle = query.trim().toLowerCase();
      out = out.filter((row) =>
        searchKeys.some((key) => String(row[key] ?? '').toLowerCase().includes(needle)),
      );
    }

    if (filterIndex != null && quickFilters?.[filterIndex]) {
      out = out.filter((row) =>
        quickFilters[filterIndex].test(row as unknown as Record<string, unknown>),
      );
    }

    return out;
  }, [rows, query, searchKeys, filterIndex, quickFilters]);

  const hasControls = Boolean(searchKeys?.length) || Boolean(quickFilters?.length);

  // The toolbar closes over the filename rather than taking it through
  // slotProps — the grid's slotProps type does not carry custom props.
  const toolbarSlot = useMemo(
    () =>
      exportFileName
        ? {
            toolbar: function ExportToolbar() {
              return (
                <GridToolbarContainer
                  sx={{ p: 1, justifyContent: 'flex-end' }}
                  className="no-print"
                >
                  <GridToolbarExport
                    csvOptions={{ fileName: exportFileName, utf8WithBom: true }}
                    printOptions={{ disableToolbarButton: true }}
                  />
                </GridToolbarContainer>
              );
            },
          }
        : undefined,
    [exportFileName],
  );

  return (
    <Box>
      {hasControls && (
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          sx={{ mb: 2, alignItems: { xs: 'stretch', md: 'center' } }}
          className="no-print"
        >
          {searchKeys?.length ? (
            <TextField
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              sx={{ minWidth: { md: 260 } }}
              slotProps={{
                // A placeholder is not an accessible name — it is a hint at
                // best, and it disappears the moment anything is typed. The
                // label goes on `htmlInput` rather than `input`: `input` is
                // the React Input component, `htmlInput` is the DOM node a
                // screen reader actually lands on. Put on the TextField
                // itself it decorates the wrapper div and names nothing,
                // which is how the first attempt at this changed no outcome.
                htmlInput: { 'aria-label': searchPlaceholder },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
          ) : null}

          {quickFilters?.length ? (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={filterIndex}
              onChange={(_, next) => setFilterIndex(next)}
              sx={{ flexWrap: 'wrap' }}
            >
              {quickFilters.map((filter, i) => (
                <ToggleButton key={filter.label} value={i} sx={{ px: 1.75 }}>
                  {filter.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          ) : null}

          <Box sx={{ flex: 1 }} />

          <Typography variant="caption" color="text.secondary" className="tabular">
            {visible.length} of {rows.length}
          </Typography>
        </Stack>
      )}

      <DataGrid
        rows={visible}
        columns={columns}
        autoHeight={height == null}
        disableRowSelectionOnClick
        disableColumnMenu
        pageSizeOptions={[10, 25, 50, 100]}
        initialState={{ pagination: { paginationModel: { pageSize } } }}
        onRowClick={
          onRowHref
            ? (params: GridRowParams) => router.push(onRowHref(params.row as R))
            : undefined
        }
        slots={toolbarSlot}
        showToolbar={Boolean(exportFileName)}
        localeText={{ noRowsLabel: emptyLabel }}
        rowHeight={56}
        columnHeaderHeight={46}
        sx={{
          ...(height != null ? { height } : {}),
          ...(onRowHref ? { '& .MuiDataGrid-row': { cursor: 'pointer' } } : {}),
        }}
      />
    </Box>
  );
}

