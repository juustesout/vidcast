'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';

import { EmptyPanel, Field } from '@/components/project/workspace-controls';
import { getReferenceUsage } from '@/lib/projects/usage';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import { joinProjectReferenceUrl } from '@/lib/utils/project-files';

interface ReferencesPanelProps {
  project: Project;
  references: ReferenceImage[];
  referenceQuery: string;
  onReferenceQueryChange: (value: string) => void;
  selectedReferenceId: string;
  onSelectReference: (referenceId: string) => void;
  onNavigateScene: (sceneId: string) => void;
  newReferenceName: string;
  newReferenceDescription: string;
  newReferenceTags: string;
  onNewReferenceNameChange: (value: string) => void;
  onNewReferenceDescriptionChange: (value: string) => void;
  onNewReferenceTagsChange: (value: string) => void;
  onImportReference: (file: File) => void;
  onSaveReferenceDetails: (reference: ReferenceImage, fields: { name: string; description: string; tags: string[] }) => void;
  onDeleteReference: () => void;
  referenceMessage: string;
}

export function ReferencesPanel({
  project,
  references,
  referenceQuery,
  onReferenceQueryChange,
  selectedReferenceId,
  onSelectReference,
  onNavigateScene,
  newReferenceName,
  newReferenceDescription,
  newReferenceTags,
  onNewReferenceNameChange,
  onNewReferenceDescriptionChange,
  onNewReferenceTagsChange,
  onImportReference,
  onSaveReferenceDetails,
  onDeleteReference,
  referenceMessage
}: ReferencesPanelProps): JSX.Element {
  const referenceFileInput = useRef<HTMLInputElement | null>(null);
  const selectedReference = project.references.find((reference) => reference.id === selectedReferenceId) ?? null;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="studio-panel rounded-[28px] p-4 shadow-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-700/70 pb-4">
          <input value={newReferenceName} onChange={(event) => onNewReferenceNameChange(event.target.value)} placeholder="Reference name" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
          <input value={newReferenceDescription} onChange={(event) => onNewReferenceDescriptionChange(event.target.value)} placeholder="Description" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
          <input value={newReferenceTags} onChange={(event) => onNewReferenceTagsChange(event.target.value)} placeholder="tags,comma,separated" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
          <button type="button" onClick={() => referenceFileInput.current?.click()} className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950">Import reference</button>
          <input
            ref={referenceFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) {
                onImportReference(file);
              }
            }}
          />
          <input value={referenceQuery} onChange={(event) => onReferenceQueryChange(event.target.value)} placeholder="Filter references" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {references.map((reference) => {
            const usage = getReferenceUsage(project, reference.id);
            return (
              <button
                key={reference.id}
                type="button"
                onClick={() => onSelectReference(reference.id)}
                className={`rounded-2xl border p-3 text-left ${selectedReferenceId === reference.id ? 'border-amber-300/50 bg-amber-200/10' : 'border-slate-700/70 bg-slate-950/30'}`}
              >
                <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
                  {reference.filePath ? <Image src={joinProjectReferenceUrl(project.id, reference.id)} alt={reference.name} fill unoptimized sizes="240px" className="object-cover" /> : null}
                </div>
                <p className="mt-2 truncate text-sm font-semibold text-white">{reference.name}</p>
                <p className="text-xs text-slate-400 line-clamp-2">{reference.description}</p>
                <p className="text-xs text-slate-400">{reference.tags.join(', ') || 'No tags'} • used by {usage.length}</p>
              </button>
            );
          })}
        </div>
      </section>

      <aside className="studio-panel rounded-[28px] p-4 shadow-panel">
        {selectedReference ? (
          <ReferenceDetailCard
            project={project}
            reference={selectedReference}
            onNavigateScene={onNavigateScene}
            onSave={(fields) => onSaveReferenceDetails(selectedReference, fields)}
            onDelete={onDeleteReference}
          />
        ) : (
          <EmptyPanel message="Select a reference to inspect and edit." />
        )}
        {referenceMessage ? <p className="mt-3 text-xs text-slate-300">{referenceMessage}</p> : null}
      </aside>
    </div>
  );
}

function ReferenceDetailCard({
  project,
  reference,
  onNavigateScene,
  onSave,
  onDelete
}: {
  project: Project;
  reference: ReferenceImage;
  onNavigateScene: (sceneId: string) => void;
  onSave: (fields: { name: string; description: string; tags: string[] }) => void;
  onDelete: () => void;
}): JSX.Element {
  const [name, setName] = useState(reference.name);
  const [description, setDescription] = useState(reference.description);
  const [tags, setTags] = useState(reference.tags.join(', '));

  const usage = getReferenceUsage(project, reference.id);

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-white">Reference details</h3>
      <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
        {reference.filePath ? <Image src={joinProjectReferenceUrl(project.id, reference.id)} alt={reference.name} fill unoptimized sizes="320px" className="object-cover" /> : null}
      </div>
      <Field label="Name" value={name} onChange={(value) => setName(String(value))} />
      <Field label="Description" value={description} onChange={(value) => setDescription(String(value))} asTextArea />
      <Field label="Tags" value={tags} onChange={(value) => setTags(String(value))} />

      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Used by scenes</p>
        <div className="mt-2 space-y-2">
          {usage.map((sceneId) => {
            const scene = project.scenes.find((entry) => entry.id === sceneId);
            if (!scene) return null;
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => onNavigateScene(scene.id)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2 text-left text-sm text-slate-200"
              >
                Scene {String(scene.order).padStart(2, '0')}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() =>
            onSave({
              name,
              description,
              tags: tags
                .split(',')
                .map((entry: string) => entry.trim())
                .filter(Boolean)
            })
          }
          className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950"
        >
          Save reference
        </button>
        <button type="button" onClick={onDelete} className="rounded-2xl border border-rose-400/60 bg-rose-400/10 px-4 py-2 text-sm text-rose-100">Delete reference</button>
      </div>
    </div>
  );
}
