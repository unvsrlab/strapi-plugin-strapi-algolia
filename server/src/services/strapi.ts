import { Core, UID } from '@strapi/strapi';
import { algoliasearch } from 'algoliasearch';
import { HookEvent } from '../../../utils/event';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  getStrapiObject: async (
    event: HookEvent,
    populate: any,
    hideFields: string[]
  ) => {
    const strapiAlgolia = strapi.plugin('strapi-algolia');
    const utilsService = strapiAlgolia.service('utils');

    const { model } = event;
    const modelUid = model.uid as UID.ContentType;
    const entryId = utilsService.getEntryId(event);

    if (!entryId) {
      throw new Error(`No entry id found in event.`);
    }
    const { documentId, locale } = event.result;
    const strapiObject = await strapi.documents(modelUid).findOne({
      documentId,
      locale: typeof locale === "string" && locale.length > 0 ? locale : undefined,
      // the documentId can have a published & unpublished version associated
      // without a status filter, the unpublished version could be returned even if a published on exists,
      // which would incorrectly de-index.
      status: 'published',
      populate,
    });

    if (!strapiObject) {
      throw new Error(
        `No entry found for ${modelUid} with ID ${entryId}`
      );
    }

    return utilsService.filterProperties(strapiObject, hideFields);
  },
  afterUpdateAndCreate: async (
    _events: any[],
    populate: any,
    hideFields: string[],
    transformToBooleanFields: string[],
    transformerCallback: ((string, any) => any | null) | null,
    idPrefix: string,
    algoliaClient: ReturnType<typeof algoliasearch>,
    indexName: string,
    contentType: string
  ) => {
    const strapiAlgolia = strapi.plugin('strapi-algolia');
    const algoliaService = strapiAlgolia.service('algolia');
    const strapiService = strapiAlgolia.service('strapi');
    const utilsService = strapiAlgolia.service('utils');

    const objectsToSave: any[] = [];
    const objectsIdsToDelete: string[] = [];
    // Event content
    //  - https://github.com/strapi/strapi/blob/241fdb42ee4717520b69195ace47990e46fa4adf/packages/core/database/src/entity-manager/index.ts#L314C1-L321C79
    //  - https://github.com/strapi/strapi/blob/241fdb42ee4717520b69195ace47990e46fa4adf/packages/core/database/src/entity-manager/index.ts#L402C1-L409C79
    const events = _events as HookEvent[];

    for (const event of events) {
      try {
        if (! event.result?.publishedAt) {
          // event triggered by draft updates
          continue;
        }
        const entryId = `${idPrefix}${getDocId(event.result)}`;
        const strapiObject = await strapiService.getStrapiObject(
          event,
          populate,
          []
        );

        if (event.result?.id === strapiObject.id) {
          // double check the query result
          objectsToSave.push(
            utilsService.filterProperties(
              {
                objectID: entryId,
                ...(transformerCallback
                  ? transformerCallback(contentType, strapiObject)
                  : strapiObject),
              },
              hideFields
            )
          );
        }
      } catch (error) {
        console.error(
          `Error while updating Algolia index: ${JSON.stringify(
            error
          )}`
        );
      }
    }

    await algoliaService.createOrDeleteObjects(
      objectsToSave,
      objectsIdsToDelete,
      algoliaClient,
      indexName,
      transformToBooleanFields
    );
  },
  afterUpdateAndCreateAlreadyPopulate: async (
    contentType: string,
    articles: any[],
    idPrefix: string,
    algoliaClient: ReturnType<typeof algoliasearch>,
    indexName: string,
    transformToBooleanFields: string[] = [],
    hideFields: string[] = [],
    transformerCallback?: ((string, any) => any | null) | null
  ) => {
    const strapiAlgolia = strapi.plugin('strapi-algolia');
    const algoliaService = strapiAlgolia.service('algolia');
    const utilsService = strapiAlgolia.service('utils');

    const objectsToSave: any[] = [];
    const objectsIdsToDelete: string[] = [];

    for (const article of articles) {
      try {
        const entryId = getDocId(article);
        const entryIdWithPrefix = `${idPrefix}${entryId}`;

        if (article.publishedAt === null) {
          objectsIdsToDelete.push(entryIdWithPrefix);
        } else {
          objectsToSave.push(
            utilsService.filterProperties(
              {
                objectID: entryIdWithPrefix,
                ...(transformerCallback
                  ? transformerCallback(contentType, article)
                  : article),
              },
              hideFields
            )
          );
        }
      } catch (error) {
        console.error(
          `Error while updating Algolia index: ${JSON.stringify(
            error
          )}`
        );
      }
    }

    await algoliaService.createOrDeleteObjects(
      objectsToSave,
      objectsIdsToDelete,
      algoliaClient,
      indexName,
      transformToBooleanFields
    );
  },
  afterDeleteOneOrMany: async (
    _event: any,
    idPrefix: string,
    algoliaClient: ReturnType<typeof algoliasearch>,
    indexName: string,
    many: boolean
  ) => {
    try {
      const event = _event as HookEvent;
      // https://github.com/strapi/strapi/blob/0b05e14275f66f3bce0f2d93875c657c322c1d20/packages/core/database/src/entity-manager/index.ts#L491
      const { params, model } = event;
      const entries = await strapi.db.query(model.uid).findMany({
        where: params.where,
        populate: ['documentId', 'id', 'locale'],
      });
      const objectIDs = entries.map(
        (article) => `${idPrefix}${getDocId(article)}`
      )

      await algoliaClient.deleteObjects({ indexName, objectIDs });
    } catch (error) {
      console.error(
        `Error while deleting object(s) from Algolia index: ${error}`
      );
    }
  },
});

function getDocId({ documentId, locale, id }) {
  // https://docs.strapi.io/cms/backend-customization/models#hook-event-object
  if(!documentId) throw new Error(`documentId is null for database entry ${id}`);
  return `${documentId}-${locale ?? 'default'}`;
}
